import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Header,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Request } from 'express';
import { notifyDelistToFeishu, notifyPriceDropToFeishu } from './feishu';
import { isJdVerificationTitle, scrapeJdProduct } from './jd-product';
import { productLogger } from './product-collection';
import type { CollectedProduct } from './product-collection';
import { ProductIdentity, resolveAndParseProductUrl } from './product-url';
import type { RemotePointerInput } from './remote-browser-controls';
import { getDataRoot } from './sessions';
import { scrapeTaobaoProduct } from './taobao-product';
import type { TaobaoCollectionOptions } from './taobao-product';
import {
  checkTaobaoVerificationPage, closeTaobaoVerification, detachTaobaoVerification, getTaobaoVerificationScreenshot, isRequestedTaobaoPage,
  ownedTaobaoVerification, requireTaobaoVerification, verificationAccess, verificationBrowser,
} from './taobao-verification';

export interface PriceHistoryPoint {
  timestamp: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number | null;
  inStock: boolean;
  note?: string;
}

export interface MonitoredProduct extends CollectedProduct {
  key: string;
  platform: 'jd' | 'taobao';
  platformLabel: string;
  id: string;
  skuId: string | null;
  canonicalUrl: string;
  allTimeLow: number | null;
  allTimeLowAt: string | null;
  allTimeHigh: number | null;
  initialPrice: number | null;
  previousFinalPrice: number | null;
  lastDropAmount: number;
  historySource: 'fetched_or_realtime' | 'realtime' | 'observed';
  priceHistory: PriceHistoryPoint[];
  createdAt: string;
  updatedAt: string;
  lastAutomaticCollectionAt?: string;
}

let monitorInterval: NodeJS.Timeout | null = null;
const automaticCollectionInterval = 60 * 60 * 1000;
const monitorTick = 60 * 1000;
const firstJdRetryDelay = 15 * 60 * 1000;
const waitingForJdPriceMessage = '京东暂时限制访问，链接已保存，等待巡检采集价格。';

function getProductsStorePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'data', 'products.json');
}

function validateOrigin(req: Request) {
  const origin = req.get('origin');
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ForbiddenException('非法的请求来源协议');
    }
  } catch {
    throw new ForbiddenException('非法的请求来源');
  }
}

const simulatedPriceNotes = new Set(['历史参考价', '近期日常价', '每日历史巡检', '促销调价记录', '国补生效巡检']);

function normalizePriceHistory(product: MonitoredProduct): MonitoredProduct {
  const oldHistory = Array.isArray(product.priceHistory) ? product.priceHistory : [];
  const priceHistory = oldHistory.filter(point =>
    point && (point.finalPrice === null || (Number.isFinite(point.finalPrice) && point.finalPrice > 0)) &&
    Number.isFinite(point.pagePrice) && point.pagePrice > 0 &&
    Number.isFinite(Date.parse(point.timestamp)) &&
    !simulatedPriceNotes.has(point.note ?? '') && !/^降价触发 \(-¥\d+\)$/.test(point.note ?? ''),
  ).map(point => {
    // Older JD samples used the page price when no final quote was available.
    if (product.platform === 'jd' && product.historySource !== 'observed' &&
        point.finalPrice === point.pagePrice && !point.couponPrice && !point.subsidyPrice) {
      return { ...point, finalPrice: null };
    }
    return point;
  });
  const sameHistory = priceHistory.length === oldHistory.length && priceHistory.every((point, i) => point === oldHistory[i]);
  if (sameHistory && product.historySource === 'observed') return product;
  if (sameHistory && product.platform !== 'jd' && product.historySource === 'realtime') {
    return { ...product, historySource: 'observed' };
  }

  const quoted = priceHistory.filter((point): point is PriceHistoryPoint & { finalPrice: number } => point.finalPrice !== null);
  const lowPoint = quoted.reduce<(typeof quoted)[number] | undefined>(
    (low, point) => !low || point.finalPrice < low.finalPrice ? point : low,
    undefined,
  );
  const latest = priceHistory.at(-1);
  const previous = quoted.at(latest?.finalPrice == null ? -1 : -2);
  return {
    ...product,
    pagePrice: latest?.pagePrice ?? 0,
    couponPrice: latest?.couponPrice ?? null,
    subsidyPrice: latest?.subsidyPrice ?? null,
    finalPrice: latest?.finalPrice ?? null,
    allTimeLow: lowPoint?.finalPrice ?? null,
    allTimeLowAt: lowPoint?.timestamp ?? null,
    allTimeHigh: priceHistory.length ? Math.max(...priceHistory.map(point => point.pagePrice)) : null,
    initialPrice: quoted[0]?.finalPrice ?? null,
    previousFinalPrice: previous?.finalPrice ?? null,
    lastDropAmount: previous && latest?.finalPrice != null
      ? Math.max(0, Number((previous.finalPrice - latest.finalPrice).toFixed(2))) : 0,
    historySource: 'observed',
    priceHistory,
    updatedAt: latest?.timestamp ?? product.updatedAt,
  };
}

export function loadMonitoredProducts(): MonitoredProduct[] {
  const filePath = getProductsStorePath();
  if (!existsSync(filePath)) return [];
  let parsed: MonitoredProduct[];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    parsed = JSON.parse(raw) as MonitoredProduct[];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const products = parsed.map(normalizePriceHistory);
  if (products.some((product, index) => product !== parsed[index])) {
    try {
      saveMonitoredProducts(products);
    } catch {
      productLogger.warn('旧价格历史已过滤，暂时无法写回商品数据文件');
    }
  }
  return products;
}

export function saveMonitoredProducts(products: MonitoredProduct[]): MonitoredProduct[] {
  const filePath = getProductsStorePath();
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(products, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return products;
}

function errorWithVerificationWindow(error: unknown, access?: TaobaoCollectionOptions['access']) {
  if (ownedTaobaoVerification(access) && error instanceof BadRequestException) {
    const response = error.getResponse() as { code?: string };
    if (response.code === 'TAOBAO_VERIFICATION_REQUIRED') {
      return new BadRequestException({ ...response, verificationAvailable: true });
    }
  }
  return error;
}

interface ProductScrapeResult {
  product: MonitoredProduct;
  isNew: boolean;
  priceDropped: boolean;
  feishuPushed: boolean;
}

interface ProductScrapeRequest {
  key: string;
  response: Promise<ProductScrapeResult>;
}

type ProductCollectionOptions = TaobaoCollectionOptions & {
  automatic?: boolean;
  waitForSlot?: boolean;
  saveOnJdRateLimit?: boolean;
};

let activeScrape: (ProductScrapeRequest & { finished: Promise<void> }) | undefined;
let pendingScrape: ProductScrapeRequest | undefined;

function productCollectionBusy(key: string, reason: 'queue_full' | 'queue_timeout') {
  productLogger.warn(JSON.stringify({
    event: 'product_collection_busy',
    collectionId: randomUUID(),
    key,
    activeKey: activeScrape?.key,
    reason,
  }));
  return new ServiceUnavailableException('前一项商品采集尚未完成，请稍后再试');
}

export async function scrapeAndUpsertProduct(
  rawUrl?: string,
  { waitForSlot = true, access, saveOnJdRateLimit = false, automatic = false }: ProductCollectionOptions = {},
): Promise<ProductScrapeResult> {
  const identity = await resolveAndParseProductUrl(rawUrl);
  const key = `${identity.platform}:${identity.id}:${identity.skuId || 'default'}`;
  if (identity.platform === 'jd') {
    const pending = loadMonitoredProducts().find(product => product.key === key && product.priceHistory.length === 0);
    if (pending && Date.now() - Date.parse(pending.createdAt) < firstJdRetryDelay) {
      return { product: pending, isNew: false, priceDropped: false, feishuPushed: false };
    }
  }

  try {
    return await enqueueProductScrape(identity, key, { access, waitForSlot, automatic });
  } catch (error) {
    const response = error instanceof BadRequestException ? error.getResponse() : null;
    if (saveOnJdRateLimit && identity.platform === 'jd' && response && typeof response === 'object' &&
        'code' in response && response.code === 'JD_RATE_LIMITED') {
      const products = loadMonitoredProducts();
      const existing = products.find(product => product.key === key);
      if (!existing) {
        const product = savePendingJdProduct(identity, key, products);
        return { product, isNew: true, priceDropped: false, feishuPushed: false };
      }
      if (existing.priceHistory.length === 0) {
        return { product: existing, isNew: false, priceDropped: false, feishuPushed: false };
      }
    }
    throw error;
  }
}

function savePendingJdProduct(identity: ProductIdentity, key: string, products: MonitoredProduct[]): MonitoredProduct {
  const now = new Date().toISOString();
  const product: MonitoredProduct = {
    key,
    platform: 'jd',
    platformLabel: '京东',
    id: identity.id,
    skuId: identity.skuId,
    canonicalUrl: identity.canonicalUrl,
    title: identity.hintTitle && !isJdVerificationTitle(identity.hintTitle) ? identity.hintTitle : `京东商品 #${identity.id}`,
    imageUrl: '',
    shopName: '店铺待采集',
    brandName: '京东商品',
    spec: '规格待采集',
    category: '',
    inStock: false,
    stockText: '库存待确认',
    pagePrice: 0,
    couponPrice: null,
    subsidyPrice: null,
    finalPrice: null,
    coupons: [],
    couponDiscount: 0,
    hasSubsidy: false,
    subsidyLabel: null,
    subsidyDiscount: 0,
    allTimeLow: null,
    allTimeLowAt: null,
    allTimeHigh: null,
    initialPrice: null,
    previousFinalPrice: null,
    lastDropAmount: 0,
    historySource: 'observed',
    priceHistory: [],
    createdAt: now,
    updatedAt: now,
  };
  saveMonitoredProducts([product, ...products]);
  return product;
}

function enqueueProductScrape(
  identity: ProductIdentity, key: string, { access, waitForSlot, automatic }: ProductCollectionOptions,
): Promise<ProductScrapeResult> {
  if (activeScrape?.key === key) return activeScrape.response;
  if (pendingScrape?.key === key) return pendingScrape.response;
  if (!activeScrape && !pendingScrape) return startProductScrape(identity, key, { access, automatic });
  if (!waitForSlot) throw new ServiceUnavailableException('服务端正在采集另一个商品');
  if (!activeScrape || pendingScrape) throw productCollectionBusy(key, 'queue_full');

  let waitTimer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    waitTimer = setTimeout(() => reject(productCollectionBusy(key, 'queue_timeout')), 8000);
    waitTimer.unref();
  });
  const response = Promise.race([activeScrape.finished, deadline])
    .then(() => {
      clearTimeout(waitTimer);
      pendingScrape = undefined;
      return startProductScrape(identity, key, { access, automatic });
    })
    .finally(() => {
      clearTimeout(waitTimer);
      if (pendingScrape?.response === response) pendingScrape = undefined;
    });
  pendingScrape = { key, response };
  return response;
}

function startProductScrape(
  identity: ProductIdentity, key: string, options: ProductCollectionOptions,
): Promise<ProductScrapeResult> {
  const signal = AbortSignal.timeout(45000);
  function releaseSlot() {
    signal.removeEventListener('abort', onTimeout);
    if (activeScrape?.response === response) activeScrape = undefined;
  }
  let onTimeout: () => void;
  const timeout = new Promise<never>((_, reject) => {
    onTimeout = () => reject(new GatewayTimeoutException('商品详情采集超时，请稍后重试'));
    signal.addEventListener('abort', onTimeout, { once: true });
  });
  const work = scrapeAndSaveProduct(identity, key, signal, options);
  const response = Promise.race([work, timeout]);
  // Keep the browser slot occupied until the timed-out page has closed.
  const finished = work.then(releaseSlot, releaseSlot);
  activeScrape = { key, response, finished };
  return response;
}

async function scrapeAndSaveProduct(
  identity: ProductIdentity, key: string, signal: AbortSignal, options: ProductCollectionOptions,
): Promise<ProductScrapeResult> {
  if (options.automatic) {
    const products = loadMonitoredProducts();
    const target = products.find(product => product.key === key);
    if (!target) throw new NotFoundException('未找到该监控商品');
    target.lastAutomaticCollectionAt = new Date().toISOString();
    saveMonitoredProducts(products);
  }
  const scraped =
    identity.platform === 'jd'
      ? await scrapeJdProduct(identity, signal)
      : await scrapeTaobaoProduct(identity, signal, options);
  signal.throwIfAborted();
  const products = loadMonitoredProducts();
  const existingIdx = products.findIndex(p => p.key === key);
  const existing = existingIdx >= 0 ? products[existingIdx] : null;
  if (!existing && options.automatic) throw new NotFoundException('未找到该监控商品');
  const existingJd = identity.platform === 'jd' ? existing : null;

  const nowIso = new Date().toISOString();
  const newPoint: PriceHistoryPoint = {
    timestamp: nowIso,
    pagePrice: scraped.pagePrice,
    couponPrice: scraped.couponPrice,
    subsidyPrice: scraped.subsidyPrice,
    finalPrice: scraped.finalPrice,
    inStock: scraped.inStock,
    note: options.automatic ? '自动巡检采集' : existing?.priceHistory.length ? '手动刷新采集' : '首次添加采集',
  };

  const priceHistory = [...(existing?.priceHistory ?? []), newPoint].slice(-180);
  const finalPrice = newPoint.finalPrice;
  const previousLow = existing?.allTimeLow ?? null;
  const isNewLow = finalPrice !== null && (previousLow === null || finalPrice < previousLow);
  const allTimeLow = isNewLow ? finalPrice : previousLow;
  const allTimeHigh = Math.max(existing?.allTimeHigh ?? 0, newPoint.pagePrice);
  const allTimeLowAt = isNewLow ? nowIso : existing?.allTimeLowAt ?? null;
  const previousFinalPrice = existing?.finalPrice ?? existing?.previousFinalPrice ?? null;
  const priceDropped = finalPrice !== null && previousFinalPrice !== null && finalPrice < previousFinalPrice;
  const lastDropAmount = priceDropped
    ? Number((previousFinalPrice - finalPrice).toFixed(2))
    : finalPrice === null ? 0 : existing?.lastDropAmount ?? 0;

  const updatedProduct: MonitoredProduct = {
    key,
    platform: identity.platform,
    platformLabel: identity.platform === 'jd' ? '京东' : '淘宝 / 天猫',
    id: identity.id,
    skuId: identity.skuId,
    canonicalUrl: identity.canonicalUrl,
    title: existingJd && scraped.title.startsWith('京东商品 #') && !isJdVerificationTitle(existingJd.title)
      ? existingJd.title : scraped.title,
    imageUrl: scraped.imageUrl || existingJd?.imageUrl || '',
    shopName: scraped.shopName === '京东自营 / 官方旗舰店' ? existingJd?.shopName || scraped.shopName : scraped.shopName,
    brandName: scraped.brandName === '京东商品' ? existingJd?.brandName || scraped.brandName : scraped.brandName,
    spec: scraped.spec === '默认规格' ? existingJd?.spec || scraped.spec : scraped.spec,
    category: scraped.category || existingJd?.category || '',
    inStock: scraped.inStock,
    stockText: scraped.stockText,
    pagePrice: scraped.pagePrice,
    couponPrice: scraped.couponPrice,
    subsidyPrice: scraped.subsidyPrice,
    finalPrice: scraped.finalPrice,
    coupons: scraped.coupons,
    couponDiscount: scraped.couponDiscount,
    hasSubsidy: scraped.hasSubsidy,
    subsidyLabel: scraped.subsidyLabel,
    subsidyDiscount: scraped.subsidyDiscount,
    allTimeLow,
    allTimeLowAt,
    allTimeHigh,
    initialPrice: existing?.initialPrice ?? newPoint.finalPrice,
    previousFinalPrice,
    lastDropAmount,
    historySource: 'observed',
    priceHistory,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    ...(existing?.lastAutomaticCollectionAt ? { lastAutomaticCollectionAt: existing.lastAutomaticCollectionAt } : {}),
  };

  if (existingIdx >= 0) {
    products[existingIdx] = updatedProduct;
  } else {
    products.unshift(updatedProduct);
  }
  saveMonitoredProducts(products);

  let feishuPushed = false;
  if (priceDropped && finalPrice !== null && allTimeLow !== null) {
    const pushRes = await notifyPriceDropToFeishu({
      platform: updatedProduct.platform,
      productId: updatedProduct.id,
      title: updatedProduct.title,
      shopName: updatedProduct.shopName,
      url: updatedProduct.canonicalUrl,
      previousPrice: previousFinalPrice,
      currentFinalPrice: finalPrice,
      pagePrice: updatedProduct.pagePrice,
      couponPrice: updatedProduct.couponPrice,
      subsidyPrice: updatedProduct.subsidyPrice,
      coupons: updatedProduct.coupons,
      hasSubsidy: updatedProduct.hasSubsidy,
      subsidyLabel: updatedProduct.subsidyLabel,
      allTimeLow,
      isNewAllTimeLow: previousLow !== null && isNewLow,
    });
    feishuPushed = pushRes.ok;
  } else if (previousFinalPrice !== null && existing?.inStock && !updatedProduct.inStock) {
    await notifyDelistToFeishu({
      platform: updatedProduct.platform,
      title: updatedProduct.title,
      url: updatedProduct.canonicalUrl,
      lastPrice: previousFinalPrice,
      reason: updatedProduct.stockText,
    });
  }

  return {
    product: updatedProduct,
    isNew: !existing,
    priceDropped,
    feishuPushed,
  };
}

async function collectNextDueProduct() {
  if (activeScrape || pendingScrape) return;
  const now = Date.now();
  const next = loadMonitoredProducts().map(product => {
    const lastAttempt = Date.parse(product.lastAutomaticCollectionAt ?? '') || 0;
    const lastUpdate = Date.parse(product.updatedAt) || Date.parse(product.createdAt) || 0;
    const firstPendingCheck = product.platform === 'jd' && product.priceHistory.length === 0 && !lastAttempt;
    const dueAt = Math.max(lastAttempt, lastUpdate) + (firstPendingCheck ? firstJdRetryDelay : automaticCollectionInterval);
    return { product, dueAt };
  }).filter(item => item.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt)[0];
  if (next) {
    await scrapeAndUpsertProduct(next.product.canonicalUrl, { waitForSlot: false, automatic: true });
  }
}

@Controller('products')
export class ProductsController implements OnModuleInit, OnModuleDestroy {
  onModuleInit() {
    if (!monitorInterval) {
      monitorInterval = setInterval(() => collectNextDueProduct().catch(() => {}), monitorTick);
      monitorInterval.unref?.();
    }
  }

  onModuleDestroy() {
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = null;
  }

  @Get()
  list() {
    return {
      products: loadMonitoredProducts(),
    };
  }

  @Get('parse')
  async parse(@Query('url') input?: string, @Req() req?: Request) {
    return this.formatCollection(await this.collect(input, req, true));
  }

  private async collect(input?: string, req?: Request, saveOnJdRateLimit = false) {
    const access = verificationAccess(req);
    try {
      return await scrapeAndUpsertProduct(input, { access, saveOnJdRateLimit });
    } catch (error) {
      throw errorWithVerificationWindow(error, access);
    }
  }

  private formatCollection({ product, isNew, priceDropped, feishuPushed }: ProductScrapeResult) {
    const subsidyNote = product.finalPrice === null ? ' ｜ 暂未采到到手价'
      : product.hasSubsidy ? ` ｜ 国补后到手 ¥${product.finalPrice.toFixed(2)} (${product.subsidyLabel})`
      : ` ｜ 预估到手 ¥${product.finalPrice.toFixed(2)}`;
    return {
      ...product,
      platform: product.platformLabel,
      isNew,
      priceDropped,
      feishuPushed,
      message: product.priceHistory.length === 0 ? waitingForJdPriceMessage : `${isNew ? '已加入实时监控' : '已刷新最新价格'}：页面标价 ¥${product.pagePrice.toFixed(2)}${
        product.couponPrice !== null ? ` ｜ 券后 ¥${product.couponPrice.toFixed(2)}` : ''
      }${subsidyNote}`,
    };
  }

  @Get('verification/frame')
  @Header('Cache-Control', 'no-store')
  async getVerificationFrame(@Req() req: Request, @Query('after') after?: string) {
    const verification = requireTaobaoVerification(req);
    const page = verification.page;
    if (!await checkTaobaoVerificationPage(verification)) return { state: 'ready' };
    const frame = await getTaobaoVerificationScreenshot(verification, after);
    if (!await checkTaobaoVerificationPage(verification)) return { state: 'ready' };
    if (!frame) return { state: 'unchanged' };
    const url = new URL(page.url());
    return {
      state: 'verify_required',
      url: url.origin + url.pathname,
      ...frame,
      viewport: page.viewportSize() ?? { width: 1280, height: 800 },
      message: frame.screenshot ? undefined : '暂时无法显示实时画面',
    };
  }

  @Post('verification/pointer')
  async verificationPointer(@Req() req: Request, @Body() body: RemotePointerInput) {
    const verification = requireTaobaoVerification(req);
    const page = verification.page;
    if (body?.type === 'down' && !await checkTaobaoVerificationPage(verification)) {
      throw new BadRequestException('商品验证已完成，请点确定继续采集');
    }
    return verificationBrowser.update(page, () => {
      if (!isRequestedTaobaoPage(page.url(), verification.identity)) {
        throw new BadRequestException('验证页面已离开该商品');
      }
      return page;
    }, body);
  }

  @Post('verification/confirm')
  async confirmVerification(@Req() req: Request) {
    const verification = requireTaobaoVerification(req);
    if (await checkTaobaoVerificationPage(verification)) {
      throw new BadRequestException('请先在淘宝画面中完成验证，再点确定');
    }
    const { identity, page, access } = verification;
    if (verificationBrowser.isDragging(page, page)) throw new BadRequestException('请先松开鼠标再确定');
    if (activeScrape || pendingScrape) throw new ServiceUnavailableException('另一项商品正在采集，请稍后再点确定');
    detachTaobaoVerification(verification);
    const key = `${identity.platform}:${identity.id}:${identity.skuId || 'default'}`;
    try {
      return this.formatCollection(await startProductScrape(identity, key, { access, resume: verification }));
    } catch (error) {
      throw errorWithVerificationWindow(error, access);
    }
  }

  @Post('verification/cancel')
  async cancelVerification(@Req() req: Request) {
    await closeTaobaoVerification(requireTaobaoVerification(req));
    return { ok: true };
  }

  @Post(':id/refresh')
  async refreshOne(@Param('id') id: string, @Req() req: Request) {
    validateOrigin(req);
    const products = loadMonitoredProducts();
    const target = products.find(p => p.id === id || p.key === id);
    if (!target) throw new NotFoundException('未找到该监控商品');
    const result = await this.collect(target.canonicalUrl, req);
    return {
      ...result,
      message: result.product.priceHistory.length === 0 ? waitingForJdPriceMessage : `已刷新「${result.product.title.slice(0, 24)}…」${result.product.finalPrice === null
        ? `页面价格 ¥${result.product.pagePrice.toFixed(2)}，暂未采到到手价`
        : `最新到手价 ¥${result.product.finalPrice.toFixed(2)}`}`,
    };
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Request) {
    validateOrigin(req);
    const products = loadMonitoredProducts();
    const filtered = products.filter(p => p.id !== id && p.key !== id);
    saveMonitoredProducts(filtered);
    return { ok: true, products: filtered, message: '已移除该监控商品' };
  }
}
