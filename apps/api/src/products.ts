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
import { scrapeJdProduct } from './jd-product';
import { productLogger } from './product-collection';
import type { CollectedProduct } from './product-collection';
import { ProductIdentity, resolveAndParseProductUrl } from './product-url';
import type { RemotePointerInput } from './remote-browser-controls';
import { getDataRoot } from './sessions';
import { scrapeTaobaoProduct } from './taobao-product';
import type { TaobaoCollectionOptions } from './taobao-product';
import {
  checkTaobaoVerificationPage, closeTaobaoVerification, detachTaobaoVerification, isRequestedTaobaoPage,
  ownedTaobaoVerification, requireTaobaoVerification, verificationAccess, verificationBrowser,
} from './taobao-verification';

export interface PriceHistoryPoint {
  timestamp: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number;
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
  historySource: 'fetched_or_realtime' | 'realtime';
  priceHistory: PriceHistoryPoint[];
  createdAt: string;
  updatedAt: string;
}

let monitorInterval: NodeJS.Timeout | null = null;

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
    Number.isFinite(point?.finalPrice) && point.finalPrice > 0 &&
    Number.isFinite(point.pagePrice) && point.pagePrice > 0 &&
    Number.isFinite(Date.parse(point.timestamp)) &&
    !simulatedPriceNotes.has(point.note ?? '') && !/^降价触发 \(-¥\d+\)$/.test(point.note ?? ''),
  );
  if (product.historySource === 'realtime' && priceHistory.length === product.priceHistory?.length) return product;

  let lowPoint: PriceHistoryPoint | undefined;
  let allTimeHigh: number | null = null;
  for (const point of priceHistory) {
    if (!lowPoint || point.finalPrice < lowPoint.finalPrice) lowPoint = point;
    allTimeHigh = Math.max(allTimeHigh ?? 0, point.pagePrice);
  }
  const latest = priceHistory.at(-1);
  const previous = priceHistory.at(-2);
  return {
    ...product,
    pagePrice: latest?.pagePrice ?? 0,
    couponPrice: latest?.couponPrice ?? null,
    subsidyPrice: latest?.subsidyPrice ?? null,
    finalPrice: latest?.finalPrice ?? 0,
    allTimeLow: lowPoint?.finalPrice ?? null,
    allTimeLowAt: lowPoint?.timestamp ?? null,
    allTimeHigh,
    initialPrice: priceHistory[0]?.finalPrice ?? null,
    previousFinalPrice: previous?.finalPrice ?? null,
    lastDropAmount: previous && latest ? Math.max(0, Number((previous.finalPrice - latest.finalPrice).toFixed(2))) : 0,
    historySource: 'realtime',
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
  rawUrl?: string, { waitForSlot = true, access }: TaobaoCollectionOptions & { waitForSlot?: boolean } = {},
): Promise<ProductScrapeResult> {
  const identity = await resolveAndParseProductUrl(rawUrl);
  const key = `${identity.platform}:${identity.id}:${identity.skuId || 'default'}`;
  if (activeScrape?.key === key) return activeScrape.response;
  if (pendingScrape?.key === key) return pendingScrape.response;
  if (!activeScrape && !pendingScrape) return startProductScrape(identity, key, { access });
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
      return startProductScrape(identity, key, { access });
    })
    .finally(() => {
      clearTimeout(waitTimer);
      if (pendingScrape?.response === response) pendingScrape = undefined;
    });
  pendingScrape = { key, response };
  return response;
}

function startProductScrape(
  identity: ProductIdentity, key: string, options: TaobaoCollectionOptions,
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
  identity: ProductIdentity, key: string, signal: AbortSignal, options: TaobaoCollectionOptions,
): Promise<ProductScrapeResult> {
  const scraped =
    identity.platform === 'jd'
      ? await scrapeJdProduct(identity, signal)
      : await scrapeTaobaoProduct(identity, signal, options);
  signal.throwIfAborted();
  const products = loadMonitoredProducts();
  const existingIdx = products.findIndex(p => p.key === key);
  const existing = existingIdx >= 0 ? products[existingIdx] : null;

  const nowIso = new Date().toISOString();
  const newPoint: PriceHistoryPoint = {
    timestamp: nowIso,
    pagePrice: scraped.pagePrice,
    couponPrice: scraped.couponPrice,
    subsidyPrice: scraped.subsidyPrice,
    finalPrice: scraped.finalPrice,
    inStock: scraped.inStock,
    note: existing ? '实时巡检采集' : '首次添加采集',
  };

  const priceHistory = [...(existing?.priceHistory ?? []), newPoint].slice(-180);
  const previousLow = existing?.allTimeLow ?? null;
  const allTimeLow = Math.min(previousLow ?? newPoint.finalPrice, newPoint.finalPrice);
  const allTimeHigh = Math.max(existing?.allTimeHigh ?? 0, newPoint.pagePrice);
  const allTimeLowAt = previousLow === allTimeLow ? existing?.allTimeLowAt ?? nowIso : nowIso;
  const previousFinalPrice = existing?.priceHistory.at(-1)?.finalPrice ?? null;
  const priceDropped = previousFinalPrice !== null && scraped.finalPrice < previousFinalPrice;
  const lastDropAmount = priceDropped
    ? Number((previousFinalPrice - scraped.finalPrice).toFixed(2))
    : existing?.lastDropAmount ?? 0;

  const updatedProduct: MonitoredProduct = {
    key,
    platform: identity.platform,
    platformLabel: identity.platform === 'jd' ? '京东' : '淘宝 / 天猫',
    id: identity.id,
    skuId: identity.skuId,
    canonicalUrl: identity.canonicalUrl,
    title: scraped.title,
    imageUrl: scraped.imageUrl,
    shopName: scraped.shopName,
    brandName: scraped.brandName,
    spec: scraped.spec,
    category: scraped.category,
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
    historySource: 'realtime',
    priceHistory,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  if (existingIdx >= 0) {
    products[existingIdx] = updatedProduct;
  } else {
    products.unshift(updatedProduct);
  }
  saveMonitoredProducts(products);

  let feishuPushed = false;
  if (priceDropped && previousFinalPrice !== null) {
    const pushRes = await notifyPriceDropToFeishu({
      platform: updatedProduct.platform,
      productId: updatedProduct.id,
      title: updatedProduct.title,
      shopName: updatedProduct.shopName,
      url: updatedProduct.canonicalUrl,
      previousPrice: previousFinalPrice,
      currentFinalPrice: updatedProduct.finalPrice,
      pagePrice: updatedProduct.pagePrice,
      couponPrice: updatedProduct.couponPrice,
      subsidyPrice: updatedProduct.subsidyPrice,
      coupons: updatedProduct.coupons,
      hasSubsidy: updatedProduct.hasSubsidy,
      subsidyLabel: updatedProduct.subsidyLabel,
      allTimeLow,
      isNewAllTimeLow: previousLow !== null && newPoint.finalPrice < previousLow,
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

@Controller('products')
export class ProductsController implements OnModuleInit {
  onModuleInit() {
    if (!monitorInterval) {
      // 每 15 分钟自动后台巡检所有已关注商品的价格变动
      monitorInterval = setInterval(async () => {
        const list = loadMonitoredProducts();
        for (const item of list) {
          try {
            await scrapeAndUpsertProduct(item.canonicalUrl, { waitForSlot: false });
          } catch {
            // ignore single item failure during background poll
          }
        }
      }, 15 * 60 * 1000);
      monitorInterval.unref?.();
    }
  }

  @Get()
  list() {
    return {
      products: loadMonitoredProducts(),
    };
  }

  @Get('parse')
  async parse(@Query('url') input?: string, @Req() req?: Request) {
    return this.formatCollection(await this.collect(input, req));
  }

  private async collect(input?: string, req?: Request) {
    const access = verificationAccess(req);
    try {
      return await scrapeAndUpsertProduct(input, { access });
    } catch (error) {
      throw errorWithVerificationWindow(error, access);
    }
  }

  private formatCollection({ product, isNew, priceDropped, feishuPushed }: ProductScrapeResult) {
    const subsidyNote = product.hasSubsidy
      ? ` ｜ 国补后到手 ¥${product.finalPrice.toFixed(2)} (${product.subsidyLabel})`
      : ` ｜ 预估到手 ¥${product.finalPrice.toFixed(2)}`;
    return {
      ...product,
      platform: product.platformLabel,
      isNew,
      priceDropped,
      feishuPushed,
      message: `${isNew ? '已加入实时监控' : '已刷新最新价格'}：页面标价 ¥${product.pagePrice.toFixed(2)}${
        product.couponPrice !== null ? ` ｜ 券后 ¥${product.couponPrice.toFixed(2)}` : ''
      }${subsidyNote}`,
    };
  }

  @Get('verification/frame')
  @Header('Cache-Control', 'no-store')
  async getVerificationFrame(@Req() req: Request) {
    const verification = requireTaobaoVerification(req);
    const page = verification.page;
    if (!await checkTaobaoVerificationPage(verification)) return { state: 'ready' };
    const screenshot = await verificationBrowser.screenshot(page, page);
    if (!await checkTaobaoVerificationPage(verification)) return { state: 'ready' };
    const url = new URL(page.url());
    return {
      state: 'verify_required',
      url: url.origin + url.pathname,
      screenshot,
      viewport: page.viewportSize() ?? { width: 1280, height: 800 },
      message: screenshot ? undefined : '暂时无法显示实时画面',
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
      message: `已刷新「${result.product.title.slice(0, 24)}…」最新到手价 ¥${result.product.finalPrice.toFixed(2)}`,
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
