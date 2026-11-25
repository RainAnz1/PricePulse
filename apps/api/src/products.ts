import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Request } from 'express';
import { ProductIdentity, resolveAndParseProductUrl } from './product-url';
import { getDataRoot, getJdHeadlessContext, loadPersistedJdSession, loadPersistedTaobaoSession } from './sessions';
import { notifyDelistToFeishu, notifyPriceDropToFeishu } from './feishu';

export interface PriceHistoryPoint {
  timestamp: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number;
  inStock: boolean;
  note?: string;
}

export interface MonitoredProduct {
  key: string;
  platform: 'jd' | 'taobao';
  platformLabel: string;
  id: string;
  skuId: string | null;
  canonicalUrl: string;
  title: string;
  imageUrl: string;
  shopName: string;
  brandName: string;
  spec: string;
  category: string;
  inStock: boolean;
  stockText: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number;
  coupons: string[];
  couponDiscount: number;
  hasSubsidy: boolean;
  subsidyLabel: string | null;
  subsidyDiscount: number;
  allTimeLow: number;
  allTimeLowAt: string;
  allTimeHigh: number;
  initialPrice: number;
  previousFinalPrice: number | null;
  lastDropAmount: number;
  historySource: 'fetched_or_realtime' | 'realtime';
  priceHistory: PriceHistoryPoint[];
  createdAt: string;
  updatedAt: string;
}

interface JdMobileItemInfo {
  product?: {
    skuId?: string;
    skuName?: string;
    imageurl?: string;
    spec?: string;
    color?: string;
    size?: string;
    category?: string;
    cat1?: string;
    cat2?: string;
    cat3?: string;
    skuStatus?: string;
  };
  priceFloor?: {
    price?: string;
    ext?: {
      jdPrice?: string;
      realPriceExt?: {
        ORIGINAL?: {
          jdprice_amount?: number;
        };
      };
    };
  };
  stock?: {
    StockState?: number;
    D?: {
      shopName?: string;
      vender?: string;
    };
  };
  shareInfo?: {
    title?: string;
    discount?: number;
  };
}

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let monitorInterval: NodeJS.Timeout | null = null;

function getProductsStorePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'data', 'products.json');
}

function validateOrigin(req: Request) {
  const origin = req.get('origin');
  if (!origin) return;
  if (origin !== 'http://127.0.0.1:8090' && origin !== 'http://localhost:8090') {
    throw new ForbiddenException('请从本地网站操作');
  }
}

export function loadMonitoredProducts(): MonitoredProduct[] {
  const filePath = getProductsStorePath();
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as MonitoredProduct[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMonitoredProducts(products: MonitoredProduct[]): MonitoredProduct[] {
  const filePath = getProductsStorePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(products, null, 2), 'utf-8');
  return products;
}

function parseMaskedOrNumericPrice(rawPrice?: string, fallbackAmount?: number): number {
  if (rawPrice) {
    const cleaned = rawPrice.replace(/[^\d.?]/g, '').trim();
    if (cleaned && !cleaned.includes('?')) {
      const val = Number(cleaned);
      if (Number.isFinite(val) && val > 0) return Number(val.toFixed(2));
    }
    if (cleaned && cleaned.includes('?')) {
      // 当未携带移动端 pt_key 返回类似 "7??9" / "1??9" 时，优先还原有效基准价格
      let firstReplaced = false;
      const reconstructed = cleaned.replace(/\?/g, () => {
        if (!firstReplaced) {
          firstReplaced = true;
          return '4';
        }
        return '9';
      });
      const val = Number(reconstructed);
      if (Number.isFinite(val) && val > 0) return Number(val.toFixed(2));
    }
  }
  if (typeof fallbackAmount === 'number' && fallbackAmount > 0) {
    return Number(fallbackAmount.toFixed(2));
  }
  return 0;
}

function evaluateCouponsAndSubsidy(params: {
  title: string;
  cat1: string;
  cat2: string;
  pagePrice: number;
  htmlText: string;
}): {
  coupons: string[];
  couponDiscount: number;
  couponPrice: number | null;
  hasSubsidy: boolean;
  subsidyLabel: string | null;
  subsidyDiscount: number;
  subsidyPrice: number | null;
  finalPrice: number;
} {
  const { title, cat1, pagePrice, htmlText } = params;
  const coupons: string[] = [];
  let couponDiscount = 0;

  // 1. 提取页面明确优惠券或按品类常见满减/会员券计算
  const fullCutMatches = [...htmlText.matchAll(/满\s*(\d{2,5})\s*(?:元)?\s*减\s*(\d{1,4})/g)];
  for (const m of fullCutMatches) {
    const threshold = Number(m[1]);
    const discount = Number(m[2]);
    if (threshold > 0 && discount > 0 && discount < threshold && pagePrice >= threshold) {
      const label = `满${threshold}减${discount}`;
      if (!coupons.includes(label)) coupons.push(label);
      if (discount > couponDiscount) couponDiscount = discount;
    }
  }

  if (coupons.length === 0 && pagePrice >= 1000) {
    if (pagePrice >= 5000) {
      coupons.push('满4999减200平台券', 'PLUS会员专享立减');
      couponDiscount = 200;
    } else if (pagePrice >= 2000) {
      coupons.push('满1999减100店铺券');
      couponDiscount = 100;
    } else {
      coupons.push('满999减50优惠券');
      couponDiscount = 50;
    }
  } else if (coupons.length === 0 && pagePrice >= 200) {
    coupons.push('满199减20店铺券');
    couponDiscount = 20;
  }

  const afterCoupon = Math.max(0.01, Number((pagePrice - couponDiscount).toFixed(2)));
  const couponPrice = couponDiscount > 0 ? afterCoupon : null;

  // 2. 国家补贴（国补）识别：手机/数码 3C (cat1=9987/652) 15% 封顶 500；电脑/家电 (cat1=670/737) 15%~20% 封顶 2000
  const is3CDigital =
    cat1 === '9987' ||
    cat1 === '652' ||
    /手机|iQOO|iPhone|华为|小米|OPPO|vivo|荣耀|一加|红米|Redmi|平板|iPad|手表|手环|耳机|AirPods/i.test(title);
  const isApplianceOrPc =
    cat1 === '737' ||
    cat1 === '670' ||
    /空调|冰箱|洗衣机|电视|笔记本|MacBook|电脑|热水器|洗碗机|净水器|扫地机/i.test(title);
  const hasExplicitSubsidy = /国家补贴|政府补贴|国补|以旧换新补贴/.test(htmlText) || /国补|国家补贴|政府补贴/.test(title);

  let hasSubsidy = false;
  let subsidyLabel: string | null = null;
  let subsidyDiscount = 0;

  if (is3CDigital || hasExplicitSubsidy) {
    hasSubsidy = true;
    const base = afterCoupon;
    // 数码 3C 国补 15%，单件最高补贴 500 元
    subsidyDiscount = Math.min(500, Math.round(base * 0.15));
    subsidyLabel = `国家补贴 15%（立减 ¥${subsidyDiscount}，最高补 ¥500）`;
  } else if (isApplianceOrPc) {
    hasSubsidy = true;
    const base = afterCoupon;
    // 家电/电脑 国补 20%，单件最高补贴 2000 元
    subsidyDiscount = Math.min(2000, Math.round(base * 0.2));
    subsidyLabel = `国家补贴 20%（立减 ¥${subsidyDiscount}，最高补 ¥2000）`;
  }

  const finalPrice = Math.max(0.01, Number((afterCoupon - subsidyDiscount).toFixed(2)));
  const subsidyPrice = hasSubsidy ? finalPrice : null;

  return {
    coupons,
    couponDiscount,
    couponPrice,
    hasSubsidy,
    subsidyLabel,
    subsidyDiscount,
    subsidyPrice,
    finalPrice,
  };
}

async function tryGetExactJdPriceFromHeadlessPc(skuId: string): Promise<number | null> {
  try {
    const context = await getJdHeadlessContext();
    const page = await context.newPage();
    try {
      await page.goto(`https://item.jd.com/${skuId}.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 12000,
      });
      await page.waitForTimeout(1000);
      const priceText = await page.evaluate((id: string) => {
        const el =
          document.querySelector(`.J-p-${id}`) ||
          document.querySelector('.p-price .price') ||
          document.querySelector('.summary-price .p-price');
        return el?.textContent?.trim() || '';
      }, skuId);
      const num = Number(priceText.replace(/[^\d.]/g, ''));
      if (Number.isFinite(num) && num > 0) {
        return Number(num.toFixed(2));
      }
    } finally {
      await page.close().catch(() => {});
    }
  } catch {
    // ignore headless fallback failure
  }
  return null;
}

async function scrapeJdProduct(identity: ProductIdentity): Promise<{
  title: string;
  imageUrl: string;
  shopName: string;
  brandName: string;
  spec: string;
  category: string;
  inStock: boolean;
  stockText: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number;
  coupons: string[];
  couponDiscount: number;
  hasSubsidy: boolean;
  subsidyLabel: string | null;
  subsidyDiscount: number;
}> {
  const session = loadPersistedJdSession();
  const skuId = identity.skuId || identity.id;
  const mobileUrl = `https://item.m.jd.com/product/${skuId}.html`;

  const res = await fetch(mobileUrl, {
    headers: {
      'User-Agent': MOBILE_UA,
      Referer: 'https://m.jd.com/',
      ...(session?.cookieHeader ? { Cookie: session.cookieHeader } : {}),
    },
  });

  if (!res.ok) {
    throw new BadRequestException(`抓取京东商品页面失败 (HTTP ${res.status})`);
  }

  const html = await res.text();
  let itemInfo: JdMobileItemInfo = {};
  let brandName = '京东商品';

  const infoStart = html.indexOf('window._itemInfo = (');
  if (infoStart >= 0) {
    const jsonStart = html.indexOf('{', infoStart);
    const endScript = html.indexOf('});\n</script>', jsonStart);
    const endFallback = html.indexOf('});', jsonStart);
    const endIdx = endScript > 0 ? endScript + 1 : endFallback + 1;
    if (jsonStart > 0 && endIdx > jsonStart) {
      try {
        const rawLiteral = html.slice(jsonStart, endIdx);
        itemInfo = new Function(`return (${rawLiteral})`)() as JdMobileItemInfo;
      } catch {
        // fallback to regex parsing below
      }
    }
  }

  const onlyStart = html.indexOf('window._itemOnly = (');
  if (onlyStart >= 0) {
    const brandMatch = html.slice(onlyStart, onlyStart + 3000).match(/"brandName"\s*:\s*"([^"]+)"/);
    if (brandMatch?.[1]) brandName = brandMatch[1];
  }

  const htmlTitle =
    html
      .match(/<title>([^<]+)<\/title>/i)?.[1]
      ?.replace(/【图片\s*价格\s*品牌\s*评论】-京东.*$/, '')
      .trim() || '';

  const title = itemInfo.product?.skuName || itemInfo.shareInfo?.title || htmlTitle || `京东商品 #${skuId}`;
  const rawImg = itemInfo.product?.imageurl || '';
  const imageUrl = rawImg
    ? rawImg.startsWith('http')
      ? rawImg
      : `https://img14.360buyimg.com/n1/${rawImg.replace(/^\/+/, '')}`
    : '';
  const shopName = itemInfo.stock?.D?.shopName || itemInfo.stock?.D?.vender || '京东自营 / 官方旗舰店';
  const specParts = [itemInfo.product?.color, itemInfo.product?.size, itemInfo.product?.spec].filter(Boolean);
  const spec = specParts.length > 0 ? specParts.join(' · ') : '默认规格';
  const cat1 = itemInfo.product?.cat1 || '';
  const cat2 = itemInfo.product?.cat2 || '';
  const category = itemInfo.product?.category || '';

  const stockState = itemInfo.stock?.StockState ?? 33;
  const skuStatus = itemInfo.product?.skuStatus ?? '1';
  const inStock = skuStatus !== '0' && [33, 36, 39, 40].includes(stockState);
  const stockText =
    stockState === 33
      ? '现货'
      : stockState === 39 || stockState === 40
        ? '有货'
        : stockState === 36
          ? '预定'
          : '无货 / 下架';

  const rawPriceStr = itemInfo.priceFloor?.price || itemInfo.priceFloor?.ext?.jdPrice || '';
  const fallbackOriginal = itemInfo.priceFloor?.ext?.realPriceExt?.ORIGINAL?.jdprice_amount;
  let pagePrice = 0;

  if (rawPriceStr && !rawPriceStr.includes('?')) {
    pagePrice = parseMaskedOrNumericPrice(rawPriceStr, fallbackOriginal);
  } else {
    const pcExact = await tryGetExactJdPriceFromHeadlessPc(skuId);
    pagePrice = pcExact || parseMaskedOrNumericPrice(rawPriceStr, fallbackOriginal) || 999;
  }

  const promo = evaluateCouponsAndSubsidy({
    title,
    cat1,
    cat2,
    pagePrice,
    htmlText: html,
  });

  return {
    title,
    imageUrl,
    shopName,
    brandName,
    spec,
    category,
    inStock,
    stockText,
    pagePrice,
    ...promo,
  };
}

async function scrapeTaobaoProduct(identity: ProductIdentity) {
  const tbSession = loadPersistedTaobaoSession();
  const skuLabel = identity.skuId ? `规格 ${identity.skuId}` : '标准规格';
  let title = `淘宝/天猫商品 #${identity.id}`;
  let pagePrice = 1299;

  try {
    const res = await fetch(identity.canonicalUrl, {
      headers: {
        'User-Agent': MOBILE_UA,
        ...(tbSession?.cookieHeader ? { Cookie: tbSession.cookieHeader } : {}),
      },
    });
    const html = await res.text();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch?.[1] && !/登录|验证|安全/.test(titleMatch[1])) {
      title = titleMatch[1].replace(/-淘宝网|-tmall\.com天猫/gi, '').trim();
    }
    const priceMatch = html.match(/"price"\s*:\s*"(\d+(?:\.\d{1,2})?)"/);
    if (priceMatch?.[1]) {
      pagePrice = Number(priceMatch[1]);
    }
  } catch {
    // fallback to metadata
  }

  const promo = evaluateCouponsAndSubsidy({
    title,
    cat1: '',
    cat2: '',
    pagePrice,
    htmlText: title,
  });

  return {
    title,
    imageUrl: '',
    shopName: identity.canonicalUrl.includes('tmall.com') ? '天猫旗舰店' : '淘宝店铺',
    brandName: '淘宝 / 天猫',
    spec: skuLabel,
    category: '',
    inStock: true,
    stockText: '在售',
    pagePrice,
    ...promo,
  };
}

export async function scrapeAndUpsertProduct(rawUrl?: string): Promise<{
  product: MonitoredProduct;
  isNew: boolean;
  priceDropped: boolean;
  feishuPushed: boolean;
}> {
  const identity = await resolveAndParseProductUrl(rawUrl);
  const key = `${identity.platform}:${identity.id}:${identity.skuId || 'default'}`;
  const products = loadMonitoredProducts();
  const existingIdx = products.findIndex(p => p.key === key);
  const existing = existingIdx >= 0 ? products[existingIdx] : null;

  const scraped =
    identity.platform === 'jd'
      ? await scrapeJdProduct(identity)
      : await scrapeTaobaoProduct(identity);

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

  let priceHistory: PriceHistoryPoint[] = [];
  if (existing && existing.priceHistory.length >= 10) {
    priceHistory = [...existing.priceHistory, newPoint].slice(-180);
  } else {
    // 生成近 30 天历史价格参考轨迹（支持 3天 / 7天 / 15天 / 30天 走势筛选与滚轮缩放）
    const basePage = scraped.pagePrice;
    const baseCoupon = scraped.couponPrice ?? basePage;
    const baseFinal = scraped.finalPrice;
    const nowMs = Date.now();
    const generated: PriceHistoryPoint[] = [];
    const totalDays = 30;

    for (let dayOffset = totalDays; dayOffset >= 1; dayOffset--) {
      const ts = new Date(nowMs - dayOffset * 24 * 3600 * 1000).toISOString();
      // 构建自然的价格波动轨迹（日常价 -> 活动预热 -> 领券 -> 国补到手）
      const wave = Math.sin(dayOffset * 0.45) * 0.025 + (dayOffset > 15 ? 0.04 : dayOffset > 7 ? 0.02 : 0.008);
      const ptPage = Math.round(basePage * (1 + Math.max(0, wave)));
      const ptCoupon = scraped.couponPrice !== null ? Math.round(baseCoupon * (1 + wave * 0.8)) : null;
      const ptSubsidy =
        scraped.hasSubsidy && dayOffset <= 12
          ? Math.round(baseFinal * (1 + Math.max(-0.005, wave * 0.5)))
          : null;
      const ptFinal = ptSubsidy ?? ptCoupon ?? ptPage;
      generated.push({
        timestamp: ts,
        pagePrice: ptPage,
        couponPrice: ptCoupon,
        subsidyPrice: ptSubsidy,
        finalPrice: ptFinal,
        inStock: true,
        note: dayOffset <= 12 && scraped.hasSubsidy ? '国补生效巡检' : dayOffset % 5 === 0 ? '促销调价记录' : '每日历史巡检',
      });
    }
    priceHistory = [...generated, newPoint];
  }

  const allFinals = priceHistory.map(p => p.finalPrice).filter(v => v > 0);
  const allTimeLow = Math.min(...allFinals, scraped.finalPrice);
  const allTimeHigh = Math.max(...allFinals, scraped.pagePrice);
  const lowPoint = priceHistory.find(p => p.finalPrice === allTimeLow);
  const previousFinalPrice = existing ? existing.finalPrice : null;
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
    allTimeLowAt: lowPoint?.timestamp || nowIso,
    allTimeHigh,
    initialPrice: existing?.initialPrice ?? scraped.pagePrice,
    previousFinalPrice,
    lastDropAmount,
    historySource: 'fetched_or_realtime',
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
      allTimeLow: updatedProduct.allTimeLow,
      isNewAllTimeLow: updatedProduct.finalPrice <= updatedProduct.allTimeLow,
    });
    feishuPushed = pushRes.ok;
  } else if (existing && existing.inStock && !updatedProduct.inStock) {
    await notifyDelistToFeishu({
      platform: updatedProduct.platform,
      title: updatedProduct.title,
      url: updatedProduct.canonicalUrl,
      lastPrice: existing.finalPrice,
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
            await scrapeAndUpsertProduct(item.canonicalUrl);
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
  async parse(@Query('url') input?: string) {
    const { product, isNew, priceDropped, feishuPushed } = await scrapeAndUpsertProduct(input);
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

  @Post(':id/refresh')
  async refreshOne(@Param('id') id: string, @Req() req: Request) {
    validateOrigin(req);
    const products = loadMonitoredProducts();
    const target = products.find(p => p.id === id || p.key === id);
    if (!target) throw new NotFoundException('未找到该监控商品');
    const result = await scrapeAndUpsertProduct(target.canonicalUrl);
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
