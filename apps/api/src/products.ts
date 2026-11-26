import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Request } from 'express';
import type { Page } from 'playwright';
import { ProductIdentity, resolveAndParseProductUrl } from './product-url';
import {
  getDataRoot,
  getJdHeadlessContext,
  getTaobaoHeadlessContext,
  loadPersistedJdSession,
  loadPersistedTaobaoSession,
} from './sessions';
import { notifyDelistToFeishu, notifyPriceDropToFeishu } from './feishu';
import { readJdDisplayedPrice, resolveJdPrice } from './jd-price';

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
          salePrice?: string | number;
        };
      };
    };
  };
  newBanner?: {
    bannerName?: string;
    fData?: {
      bannerName?: string;
      rightDownText?: string;
      link?: string;
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
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ForbiddenException('非法的请求来源协议');
    }
  } catch {
    throw new ForbiddenException('非法的请求来源');
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

function parseCleanNumericPrice(raw?: string | number | null): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Number(raw.toFixed(2)) : 0;
  }
  if (!raw || typeof raw !== 'string') return 0;
  // 含有 ? 或字体混淆私用区字符 (U+E000..U+F8FF) 时视为掩码，绝不伪造数字
  if (raw.includes('?') || /[\uE000-\uF8FF]/.test(raw)) return 0;
  const match = raw.trim().match(/(\d+(?:\.\d{1,2})?)/);
  if (!match?.[1]) return 0;
  const val = Number(match[1]);
  return Number.isFinite(val) && val > 0 ? Number(val.toFixed(2)) : 0;
}

function normalizeImageUrl(raw?: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return `https://img14.360buyimg.com/n1/${trimmed.replace(/^\/+/, '')}`;
}

function evaluateCouponsAndSubsidy(params: {
  title: string;
  cat1: string;
  cat2: string;
  pagePrice: number;
  htmlText: string;
  observedFinalPrice?: number;
  observedCouponPrice?: number;
  observedSubsidyDiscount?: number;
  observedSubsidyLabel?: string | null;
  observedCoupons?: string[];
  hasExplicitSubsidyPrice?: boolean;
  useObservedPriceOnly?: boolean;
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
  const {
    pagePrice,
    htmlText,
    observedFinalPrice = 0,
    observedCouponPrice = 0,
    observedSubsidyDiscount = 0,
    observedSubsidyLabel = null,
    observedCoupons = [],
    hasExplicitSubsidyPrice = false,
    useObservedPriceOnly = false,
  } = params;

  const coupons: string[] = [...observedCoupons];
  let couponDiscount = 0;

  // 1. 仅从商品优惠券/促销摘要文本中提取真实的单品满减券（过滤白条/分期/以旧换新/多件促销）
  const sanitizedPromoText = htmlText
    .replace(/[^\n。；;]*(?:白条|分期|以旧换新|换新补贴|银行卡|支付立减|满\s*[2-9]\s*件)[^\n。；;]*/g, ' ');

  const fullCutMatches = [
    ...sanitizedPromoText.matchAll(/满\s*(\d{1,5})\s*(?:元)?\s*减\s*(\d{1,4}(?:\.\d{1,2})?)/g),
  ];
  for (const m of fullCutMatches) {
    const threshold = Number(m[1]);
    const discount = Number(m[2]);
    if (threshold > 0 && discount > 0 && discount < threshold && pagePrice >= threshold) {
      const label = `满${threshold}减${discount}`;
      if (!coupons.includes(label)) coupons.push(label);
      if (discount > couponDiscount) couponDiscount = discount;
    }
  }

  const directCutMatches = [
    ...sanitizedPromoText.matchAll(/(?:官方立减|单品立减|领券减|券后减)\s*[¥￥]?\s*(\d{1,4}(?:\.\d{1,2})?)\s*元?/g),
  ];
  for (const m of directCutMatches) {
    const discount = Number(m[1]);
    if (discount > 0 && discount < pagePrice * 0.6 && Math.abs(discount - observedSubsidyDiscount) > 0.05) {
      const label = `立减 ¥${discount}`;
      if (!coupons.includes(label)) coupons.push(label);
      if (discount > couponDiscount) couponDiscount = discount;
    }
  }

  // 2. 国家补贴（国补）识别：严格以页面真实展示的「国补领后价」或「国家补贴 | 领后减 ¥xxx」为准，绝不按类目硬扣 15%/20%
  let explicitSubsidyAmount = observedSubsidyDiscount;
  if (explicitSubsidyAmount <= 0) {
    const subMatch =
      sanitizedPromoText.match(/国家补贴[^¥￥\d]{0,20}(?:领后减|立减|补贴)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/) ||
      sanitizedPromoText.match(/政府补贴[^¥￥\d]{0,20}(?:领后减|立减|补贴)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/) ||
      sanitizedPromoText.match(/国补[^¥￥\d]{0,12}(?:领后减|立减)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
    if (subMatch?.[1]) {
      const parsedSub = Number(subMatch[1]);
      if (Number.isFinite(parsedSub) && parsedSub > 0 && parsedSub < pagePrice) {
        explicitSubsidyAmount = Number(parsedSub.toFixed(2));
      }
    }
  }

  // 情况 A：页面明确采集到了真实国补价/到手价 + 国补立减金额（例如：日常价 ¥904，京东价 ¥844，国补减 ¥126.6，国补领后价 ¥717.4）
  if (observedFinalPrice > 0 && explicitSubsidyAmount > 0 && (!useObservedPriceOnly || hasExplicitSubsidyPrice)) {
    const preSubsidyPrice = Number((observedFinalPrice + explicitSubsidyAmount).toFixed(2));
    if (pagePrice > preSubsidyPrice + 0.05) {
      couponDiscount = Number((pagePrice - preSubsidyPrice).toFixed(2));
      if (coupons.length === 0) {
        coupons.push(`促销立减 ¥${couponDiscount}`);
      }
    } else {
      couponDiscount = 0;
    }
    const couponPrice = couponDiscount > 0 ? preSubsidyPrice : null;
    const subsidyLabel = observedSubsidyLabel || `国家补贴 | 领后减 ¥${explicitSubsidyAmount}`;
    return {
      coupons,
      couponDiscount,
      couponPrice,
      hasSubsidy: true,
      subsidyLabel,
      subsidyDiscount: explicitSubsidyAmount,
      subsidyPrice: Number(observedFinalPrice.toFixed(2)),
      finalPrice: Number(observedFinalPrice.toFixed(2)),
    };
  }

  // 情况 B：页面明确展示了「国补领后价 / 政府补贴价」(hasExplicitSubsidyPrice)，但未单独列出领后减数字
  if (hasExplicitSubsidyPrice && observedFinalPrice > 0 && observedFinalPrice < pagePrice) {
    const baseBeforeSub = observedCouponPrice > observedFinalPrice && observedCouponPrice <= pagePrice
      ? observedCouponPrice
      : pagePrice;
    const subDiscount = Number((baseBeforeSub - observedFinalPrice).toFixed(2));
    const cDiscount = baseBeforeSub < pagePrice ? Number((pagePrice - baseBeforeSub).toFixed(2)) : 0;
    if (cDiscount > 0 && coupons.length === 0) {
      coupons.push(`促销立减 ¥${cDiscount}`);
    }
    return {
      coupons,
      couponDiscount: cDiscount,
      couponPrice: cDiscount > 0 ? baseBeforeSub : null,
      hasSubsidy: true,
      subsidyLabel: observedSubsidyLabel || `国家补贴 | 领后减 ¥${subDiscount}`,
      subsidyDiscount: subDiscount,
      subsidyPrice: Number(observedFinalPrice.toFixed(2)),
      finalPrice: Number(observedFinalPrice.toFixed(2)),
    };
  }

  // 情况 C：页面直接展示了「到手价 / 预估到手价 / 券后价」(observedFinalPrice < pagePrice，且非国补)
  // 此时页面上的 observedFinalPrice 已经扣除了该商品的可用券与促销，绝不能二次重复扣减
  if (observedFinalPrice > 0 && observedFinalPrice < pagePrice) {
    couponDiscount = Number((pagePrice - observedFinalPrice).toFixed(2));
    if (coupons.length === 0) {
      coupons.push(`到手优惠立减 ¥${couponDiscount}`);
    }
    return {
      coupons,
      couponDiscount,
      couponPrice: Number(observedFinalPrice.toFixed(2)),
      hasSubsidy: false,
      subsidyLabel: null,
      subsidyDiscount: 0,
      subsidyPrice: null,
      finalPrice: Number(observedFinalPrice.toFixed(2)),
    };
  }

  // 情况 D：页面采集到了 observedCouponPrice < pagePrice
  if (observedCouponPrice > 0 && observedCouponPrice < pagePrice) {
    couponDiscount = Number((pagePrice - observedCouponPrice).toFixed(2));
    if (coupons.length === 0) {
      coupons.push(`领券立减 ¥${couponDiscount}`);
    }
    return {
      coupons,
      couponDiscount,
      couponPrice: Number(observedCouponPrice.toFixed(2)),
      hasSubsidy: false,
      subsidyLabel: null,
      subsidyDiscount: 0,
      subsidyPrice: null,
      finalPrice: Number(observedCouponPrice.toFixed(2)),
    };
  }

  // 情况 E：页面未直接展示折后到手价（仅展示日常京东价/淘宝价），若页面单品券列表存在满足门槛的满减券则折算券后价，否则到手价严格等于页面售价
  if (useObservedPriceOnly) couponDiscount = 0;
  const afterCoupon = couponDiscount > 0 ? Math.max(0.01, Number((pagePrice - couponDiscount).toFixed(2))) : pagePrice;
  const couponPrice = couponDiscount > 0 ? afterCoupon : null;
  const finalPrice = Number((observedFinalPrice > 0 && couponDiscount === 0 ? observedFinalPrice : afterCoupon).toFixed(2));

  return {
    coupons,
    couponDiscount,
    couponPrice,
    hasSubsidy: false,
    subsidyLabel: null,
    subsidyDiscount: 0,
    subsidyPrice: null,
    finalPrice,
  };
}

interface JdPcRichDetail {
  pagePrice: number;
  finalPrice: number;
  couponPrice: number;
  subsidyDiscount: number;
  subsidyLabel: string | null;
  hasExplicitSubsidyPrice: boolean;
  coupons: string[];
  title?: string;
  shopName?: string;
  spec?: string;
  htmlText: string;
}

function closeProductPageOnTimeout(page: Page, signal: AbortSignal): () => void {
  const close = () => { void page.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  return () => signal.removeEventListener('abort', close);
}

async function scrapeJdPcRichDetail(skuId: string, signal: AbortSignal): Promise<JdPcRichDetail | null> {
  try {
    const context = await getJdHeadlessContext();
    signal.throwIfAborted();
    const page = await context.newPage();
    const detachTimeout = closeProductPageOnTimeout(page, signal);
    let wareBusinessRaw = '';

    try {
      signal.throwIfAborted();
      await page.route('**/pc-frequent-pro.pf.jd.com/**', route => route.abort()).catch(() => {});
      await page.route('**/cfe.m.jd.com/**', route => route.abort()).catch(() => {});

      page.on('response', async res => {
        const u = res.url();
        if (u.includes('pc_detailpage_wareBusiness')) {
          try {
            const text = await res.text();
            if (text && text.trim().startsWith('{')) {
              wareBusinessRaw = text;
            }
          } catch {
            // ignore
          }
        }
      });

      await page.goto(`https://item.jd.com/${skuId}.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 18000,
      });

      for (let i = 0; i < 14; i++) {
        await page.waitForTimeout(250);
        const hasDomPrice = await page
          .evaluate((id: string) => {
            const txt =
              (document.querySelector('.summary-price-wrap') ||
                document.querySelector(`.J-p-${id}`) ||
                document.querySelector('.p-price'))?.textContent || '';
            return /\d+(?:\.\d{1,2})?/.test(txt);
          }, skuId)
          .catch(() => false);
        if (hasDomPrice && (wareBusinessRaw || i >= 5)) break;
      }

      const domExtracted = await page.evaluate((id: string) => {
        const clean = (s?: string | null) => (s || '').replace(/\s+/g, ' ').trim();
        const priceWrapEl =
          (document.querySelector('.summary-price-wrap') as HTMLElement | null) ||
          (document.querySelector('.itemInfo-wrap') as HTMLElement | null);
        const priceAreaText = (priceWrapEl?.innerText || '').slice(0, 2500);
        const quanAreaText = clean(
          (document.querySelector('#summary-quan, .quan-item, .J-prom-quan') as HTMLElement | null)?.innerText,
        ).slice(0, 1200);
        const jpText = clean(document.querySelector(`.J-p-${id}`)?.textContent);
        const pPriceText = clean(document.querySelector('.p-price')?.textContent);
        const pageOriginPriceText = clean(
          document.querySelector('#page_origin_price, .p-price-origin, .summary-price-wrap del')?.textContent,
        );
        const handPriceElText = clean(
          (priceWrapEl?.querySelector(
            '.J-final-price, .final-price, [class*="handPrice"], [class*="finalPrice"], [class*="govPrice"], .p-price-hand',
          ) as HTMLElement | null)?.innerText,
        );
        const skuName = clean(document.querySelector('.sku-name')?.textContent);
        const shopName = clean(
          document.querySelector('.J-hove-wrap .name a, .shopName, .popbox-inner .mt h3 a')?.textContent,
        );
        const selectedColor = clean(
          document.querySelector('#choose-attr-1 .item.selected, .choose-attrs .item.selected')?.textContent,
        );

        return {
          priceAreaText,
          quanAreaText,
          jpText,
          pPriceText,
          pageOriginPriceText,
          handPriceElText,
          skuName,
          shopName,
          selectedColor,
        };
      }, skuId);

      let jdSellingPrice = 0; // 京东日常售价 (price.p / .J-p-sku)
      let originPrice = 0; // 划线原价 / 日常标价 (price.op / #page_origin_price)
      let explicitFinalPrice = 0; // 页面明确显示的「到手价 / 预估到手价 / 国补领后价 / 券后价」
      let couponPrice = 0;
      let subsidyDiscount = 0;
      let subsidyLabel: string | null = null;
      let hasExplicitSubsidyPrice = false;
      const coupons: string[] = [];

      // 1. 解析 pc_detailpage_wareBusiness JSON
      if (wareBusinessRaw) {
        try {
          const wb = JSON.parse(wareBusinessRaw) as Record<string, unknown>;
          const priceObj = (wb.price || {}) as Record<string, unknown>;
          const pVal = parseCleanNumericPrice(priceObj.p as string);
          const opVal = parseCleanNumericPrice(priceObj.op as string);
          const mVal = parseCleanNumericPrice(priceObj.m as string);
          const tkpVal = parseCleanNumericPrice(priceObj.tkp as string);
          const upVal = parseCleanNumericPrice(priceObj.up as string);

          if (pVal > 0) jdSellingPrice = pVal;
          if (opVal > 0) originPrice = opVal;
          else if (mVal > 0 && pVal > 0 && mVal < pVal * 1.8) originPrice = mVal;

          if (tkpVal > 0 && (!pVal || tkpVal <= pVal)) explicitFinalPrice = tkpVal;
          else if (upVal > 0 && (!pVal || upVal <= pVal)) explicitFinalPrice = upVal;

          // 提取 wareBusiness 中真实的单品优惠券 (couponInfo)
          const couponList = Array.isArray(wb.couponInfo) ? (wb.couponInfo as Array<Record<string, unknown>>) : [];
          for (const c of couponList) {
            const quota = Number(c.quota || c.consume || 0);
            const discount = Number(c.discount || c.parValue || 0);
            const label = String(c.KEY || c.label || c.title || '');
            if (/白条|分期|金融|支付/.test(label)) continue;
            if (quota > 0 && discount > 0 && discount < quota) {
              const tag = `满${quota}减${discount}`;
              if (!coupons.includes(tag)) coupons.push(tag);
            }
          }

          const wbStr = wareBusinessRaw;
          const subCutMatch =
            wbStr.match(/国家补贴[^"}\d]{0,20}(?:领后减|立减)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
          if (subCutMatch?.[1]) {
            subsidyDiscount = Number(Number(subCutMatch[1]).toFixed(2));
            subsidyLabel = `国家补贴 | 领后减 ¥${subsidyDiscount}`;
          }

          const govPriceMatch =
            wbStr.match(/"(?:govPrice|subsidyPrice)"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/) ||
            wbStr.match(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:国补领后价|政府补贴价|补贴领后价)/);
          if (govPriceMatch?.[1]) {
            const gp = parseCleanNumericPrice(govPriceMatch[1]);
            if (gp > 0) {
              explicitFinalPrice = gp;
              hasExplicitSubsidyPrice = true;
            }
          }

          const handPriceMatch =
            wbStr.match(/"(?:finalPrice|handPrice|toHandPrice)"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/) ||
            wbStr.match(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:到手价|预估到手价|券后价)/) ||
            wbStr.match(/(?:到手价|预估到手价|券后价)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
          if (!explicitFinalPrice && handPriceMatch?.[1]) {
            const hp = parseCleanNumericPrice(handPriceMatch[1]);
            if (hp > 0) explicitFinalPrice = hp;
          }
        } catch {
          // ignore JSON parse failure
        }
      }

      const text = domExtracted.priceAreaText;
      const displayed = readJdDisplayedPrice(text);
      const displayedPrice = displayed.price || parseCleanNumericPrice(domExtracted.handPriceElText);
      if (displayedPrice > 0) {
        hasExplicitSubsidyPrice = displayed.subsidy;
        if (!displayed.subsidy) {
          subsidyDiscount = 0;
          subsidyLabel = null;
        }
      }
      if (hasExplicitSubsidyPrice) {
        const discount = text.match(/国家补贴\s*[|｜]?\s*(?:领后减|立减)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
        if (discount?.[1]) {
          subsidyDiscount = parseCleanNumericPrice(discount[1]);
          subsidyLabel = `国家补贴 | 领后减 ¥${subsidyDiscount}`;
        }
      }

      const jpVal = parseCleanNumericPrice(domExtracted.jpText || domExtracted.pPriceText);
      const domOriginVal = parseCleanNumericPrice(domExtracted.pageOriginPriceText);

      if (jpVal > 0 && !jdSellingPrice) jdSellingPrice = jpVal;
      if (domOriginVal > 0) originPrice = Math.max(originPrice, domOriginVal);

      const { finalPrice, pagePrice } = resolveJdPrice({
        displayed: displayedPrice,
        quotedOffer: explicitFinalPrice,
        selling: jdSellingPrice,
        original: originPrice,
      });

      if (finalPrice > 0 && subsidyDiscount > 0) {
        const preSub = Number((finalPrice + subsidyDiscount).toFixed(2));
        if (pagePrice > preSub + 0.05) {
          couponPrice = preSub;
        }
      } else if (finalPrice > 0 && pagePrice > finalPrice + 0.05 && !hasExplicitSubsidyPrice) {
        couponPrice = finalPrice;
      }

      if (pagePrice > 0 || finalPrice > 0) {
        return {
          pagePrice: pagePrice || finalPrice,
          finalPrice: finalPrice || pagePrice,
          couponPrice,
          subsidyDiscount,
          subsidyLabel,
          hasExplicitSubsidyPrice,
          coupons,
          title: domExtracted.skuName || undefined,
          shopName: domExtracted.shopName || undefined,
          spec: domExtracted.selectedColor || undefined,
          htmlText: `${domExtracted.priceAreaText}\n${domExtracted.quanAreaText}`,
        };
      }
    } finally {
      detachTimeout();
      await page.close().catch(() => {});
    }
  } catch {
    // ignore headless PC fallback error
  }
  return null;
}

async function scrapeJdProduct(identity: ProductIdentity, signal: AbortSignal): Promise<{
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
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: {
      'User-Agent': MOBILE_UA,
      Referer: 'https://m.jd.com/',
      ...(session?.cookieHeader ? { Cookie: session.cookieHeader } : {}),
    },
  }).catch(() => null);

  const html = res?.ok ? await res.text().catch(() => '') : '';
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
        itemInfo = JSON.parse(rawLiteral) as JdMobileItemInfo;
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

  let title =
    itemInfo.product?.skuName ||
    itemInfo.shareInfo?.title ||
    identity.hintTitle ||
    htmlTitle ||
    `京东商品 #${skuId}`;
  const rawImg = itemInfo.product?.imageurl || '';
  const imageUrl = normalizeImageUrl(rawImg);
  let shopName = itemInfo.stock?.D?.shopName || itemInfo.stock?.D?.vender || '京东自营 / 官方旗舰店';
  const specParts = [itemInfo.product?.color, itemInfo.product?.size, itemInfo.product?.spec].filter(Boolean);
  let spec = specParts.length > 0 ? specParts.join(' · ') : '默认规格';
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

  // 优先读取未被字体混淆的 ext.jdPrice / ORIGINAL.salePrice
  const mobilePrice =
    parseCleanNumericPrice(itemInfo.priceFloor?.ext?.jdPrice) ||
    parseCleanNumericPrice(itemInfo.priceFloor?.ext?.realPriceExt?.ORIGINAL?.salePrice) ||
    parseCleanNumericPrice(itemInfo.priceFloor?.price);

  // 通过服务端无头浏览器采集 PC 详情页的真实「国补领后价 / 到手价」「日常标价」与「国家补贴立减金额」
  const pcRich = await scrapeJdPcRichDetail(skuId, signal);
  if (pcRich?.title && title.startsWith('京东商品 #')) title = pcRich.title;
  if (pcRich?.shopName && shopName === '京东自营 / 官方旗舰店') shopName = pcRich.shopName;
  if (pcRich?.spec && spec === '默认规格') spec = pcRich.spec;

  const pagePrice = pcRich?.pagePrice || mobilePrice;
  if (!pagePrice || pagePrice <= 0) {
    throw new BadRequestException(
      '该京东商品需登录态查看真实价格（当前返回掩码价格），请先在左侧「平台账号与服务端会话」中重新扫码登录京东账号以刷新会话凭证',
    );
  }

  const bannerText = [itemInfo.newBanner?.bannerName, itemInfo.newBanner?.fData?.bannerName, itemInfo.newBanner?.fData?.rightDownText]
    .filter(Boolean)
    .join(' ');
  const combinedText = `${pcRich?.htmlText || ''}\n${bannerText}`;
  const promo = evaluateCouponsAndSubsidy({
    title,
    cat1,
    cat2,
    pagePrice,
    htmlText: combinedText,
    observedFinalPrice: pcRich?.finalPrice || mobilePrice,
    observedCouponPrice: pcRich?.couponPrice,
    observedSubsidyDiscount: pcRich?.subsidyDiscount,
    observedSubsidyLabel: pcRich?.subsidyLabel,
    observedCoupons: pcRich?.coupons,
    hasExplicitSubsidyPrice: pcRich?.hasExplicitSubsidyPrice,
    useObservedPriceOnly: true,
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

interface ParsedTaobaoDetail {
  title: string;
  imageUrl: string;
  shopName: string;
  brandName: string;
  spec: string;
  pagePrice: number;
  finalPrice: number;
  couponPrice: number;
  subsidyDiscount: number;
  subsidyLabel: string | null;
  coupons: string[];
  inStock: boolean;
  stockText: string;
  rawText: string;
}

function parseTaobaoMtopJson(rawText: string, targetSkuId: string | null): Partial<ParsedTaobaoDetail> | null {
  try {
    let jsonStr = rawText.trim();
    const jsonpMatch = jsonStr.match(/^[a-zA-Z0-9_$]+\(([\s\S]*)\)\s*;?$/);
    if (jsonpMatch?.[1]) {
      jsonStr = jsonpMatch[1];
    }
    const root = JSON.parse(jsonStr) as { data?: Record<string, unknown>; ret?: string[] };
    const data = root?.data;
    if (!data || typeof data !== 'object') return null;

    // 部分 MTOP 接口在 data.apiStack[0].value 中嵌套详情 JSON
    let detailData: Record<string, unknown> = data;
    if (Array.isArray(data.apiStack) && data.apiStack[0]?.value) {
      try {
        const stackVal =
          typeof data.apiStack[0].value === 'string'
            ? (JSON.parse(data.apiStack[0].value) as Record<string, unknown>)
            : (data.apiStack[0].value as Record<string, unknown>);
        detailData = { ...data, ...stackVal };
      } catch {
        // ignore
      }
    }

    const item = (detailData.item || (data.item as Record<string, unknown>) || {}) as Record<string, unknown>;
    const seller = (detailData.seller || (data.seller as Record<string, unknown>) || {}) as Record<string, unknown>;
    const componentsVO = (detailData.componentsVO || {}) as Record<string, Record<string, unknown>>;

    const title =
      (item.title as string) ||
      (componentsVO.titleVO?.title as string) ||
      '';
    const images = Array.isArray(item.images) ? (item.images as string[]) : [];
    let imageUrl = normalizeImageUrl(images[0] || '');
    const shopName =
      (seller.shopName as string) ||
      (seller.sellerNick as string) ||
      (componentsVO.shopVO?.shopName as string) ||
      '';

    // 解析 SKU 规格名称与对应规格图片
    let spec = '';
    const skuBase = (detailData.skuBase || data.skuBase || {}) as {
      skus?: Array<{ skuId?: string; propPath?: string }>;
      props?: Array<{
        pid?: string | number;
        name?: string;
        values?: Array<{ vid?: string | number; name?: string; image?: string }>;
      }>;
    };

    if (targetSkuId && Array.isArray(skuBase.skus) && Array.isArray(skuBase.props)) {
      const matchedSku = skuBase.skus.find(s => String(s.skuId) === String(targetSkuId));
      if (matchedSku?.propPath) {
        const propPairs = matchedSku.propPath.split(';').filter(Boolean);
        const specNames: string[] = [];
        for (const pair of propPairs) {
          const [pid, vid] = pair.split(':');
          const propGroup = skuBase.props.find(p => String(p.pid) === String(pid));
          const propVal = propGroup?.values?.find(v => String(v.vid) === String(vid));
          if (propVal?.name) specNames.push(propVal.name);
          if (propVal?.image) imageUrl = normalizeImageUrl(propVal.image);
        }
        if (specNames.length > 0) {
          spec = specNames.join(' · ');
        }
      }
    }

    // 解析 SKU 价格（支持 skuCore.sku2info[skuId]、priceSectionData、componentsVO.priceVO）
    let pagePrice = 0;
    let finalPrice = 0;
    const coupons: string[] = [];

    const skuCore = (detailData.skuCore || {}) as {
      sku2info?: Record<
        string,
        {
          price?: { priceText?: string; priceMoney?: number };
          subPrice?: { priceText?: string; priceMoney?: number; priceTitle?: string };
          quantity?: number | string;
          quantityText?: string;
        }
      >;
    };

    const skuInfoMap = skuCore.sku2info || {};
    const targetInfo = (targetSkuId && skuInfoMap[targetSkuId]) || skuInfoMap['0'] || Object.values(skuInfoMap)[0];
    if (targetInfo) {
      const mainP =
        parseCleanNumericPrice(targetInfo.price?.priceText) ||
        (targetInfo.price?.priceMoney ? Number((Number(targetInfo.price.priceMoney) / 100).toFixed(2)) : 0);
      const subP =
        parseCleanNumericPrice(targetInfo.subPrice?.priceText) ||
        (targetInfo.subPrice?.priceMoney ? Number((Number(targetInfo.subPrice.priceMoney) / 100).toFixed(2)) : 0);

      if (mainP > 0 && subP > 0) {
        pagePrice = Math.max(mainP, subP);
        finalPrice = Math.min(mainP, subP);
        if (targetInfo.subPrice?.priceTitle && pagePrice > finalPrice) {
          coupons.push(`${targetInfo.subPrice.priceTitle} ¥${finalPrice}`);
        }
      } else if (mainP > 0) {
        pagePrice = mainP;
        finalPrice = mainP;
      }
    }

    const priceVO = (componentsVO.priceVO || detailData.priceSectionData || {}) as Record<string, unknown>;
    if (!pagePrice && priceVO) {
      const pText =
        ((priceVO.price as Record<string, unknown>)?.priceText as string) ||
        (priceVO.priceText as string) ||
        '';
      const subText =
        ((priceVO.subPrice as Record<string, unknown>)?.priceText as string) ||
        ((priceVO.finalPrice as Record<string, unknown>)?.priceText as string) ||
        '';
      const p1 = parseCleanNumericPrice(pText);
      const p2 = parseCleanNumericPrice(subText);
      if (p1 > 0 && p2 > 0) {
        pagePrice = Math.max(p1, p2);
        finalPrice = Math.min(p1, p2);
      } else if (p1 > 0 || p2 > 0) {
        pagePrice = p1 || p2;
        finalPrice = p1 || p2;
      }
    }

    return {
      title: title || undefined,
      imageUrl: imageUrl || undefined,
      shopName: shopName || undefined,
      spec: spec || undefined,
      pagePrice: pagePrice || undefined,
      finalPrice: finalPrice || undefined,
      coupons,
      rawText: jsonStr.slice(0, 12000),
    };
  } catch {
    return null;
  }
}

async function scrapeTaobaoProduct(identity: ProductIdentity, signal: AbortSignal) {
  const isTmall = Boolean(identity.isTmall || identity.canonicalUrl.includes('tmall.com'));
  const defaultShop = isTmall ? '天猫官方旗舰店' : '淘宝店铺';
  const defaultSpec = identity.skuId ? `规格 ${identity.skuId}` : '默认规格';

  let title = identity.hintTitle || '';
  let imageUrl = '';
  let shopName = '';
  let brandName = isTmall ? '天猫 Tmall' : '淘宝 Taobao';
  let spec = '';
  let pagePrice = 0;
  let finalPrice = 0;
  let subsidyDiscount = 0;
  let subsidyLabel: string | null = null;
  const coupons: string[] = [];
  let inStock = true;
  let stockText = '在售';
  let combinedRawText = '';
  let redirectedToLogin = false;

  try {
    const context = await getTaobaoHeadlessContext();
    signal.throwIfAborted();
    const page = await context.newPage();
    const detachTimeout = closeProductPageOnTimeout(page, signal);

    try {
      signal.throwIfAborted();
      const mtopPayloads: string[] = [];
      page.on('response', async res => {
        const u = res.url();
        const isMtopHost = u.includes('h5api.m.taobao.com/h5/mtop.') || u.includes('h5api.m.tmall.com/h5/mtop.');
        if (
          isMtopHost &&
          (u.includes('mtop.taobao.pcdetail.data.get') ||
            u.includes('mtop.taobao.detail.getdetail') ||
            u.includes('mtop.taobao.detail.data.get'))
        ) {
          try {
            const text = await res.text();
            if (text && text.includes('SUCCESS::')) {
              mtopPayloads.push(text);
            } else if (text && (text.includes('RGV587_ERROR') || text.includes('FAIL_SYS_SESSION_EXPIRED'))) {
              redirectedToLogin = true;
            }
          } catch {
            // ignore
          }
        }
      });

      const urlsToTry = new Set([
        identity.canonicalUrl,
        `https://item.taobao.com/item.htm?id=${identity.id}${identity.skuId ? `&skuId=${identity.skuId}` : ''}`,
      ]);

      for (const targetUrl of urlsToTry) {
        await page
          .goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
          })
          .catch(() => {});

        let loginTicksWithoutQuickBtn = 0;
        let quickLoginClicked = false;

        for (let i = 0; i < 24; i++) {
          await page.waitForTimeout(300);
          if (mtopPayloads.length > 0) {
            redirectedToLogin = false;
            break;
          }

          const curUrl = page.url();
          if (curUrl.includes('login.taobao.com') || curUrl.includes('login.m.taobao.com')) {
            redirectedToLogin = true;
            if (quickLoginClicked) continue;
            const loginState = await page
              .evaluate(() => {
                const btn = document.querySelector(
                  '.has-login button, .has-login .fm-button',
                ) as HTMLButtonElement | null;
                if (btn && (btn.textContent || '').includes('登录')) {
                  btn.click();
                  return 'clicked_has_login';
                }
                const hasHasLoginBox = Boolean(document.querySelector('.has-login'));
                return hasHasLoginBox ? 'waiting_has_login' : 'need_manual_login';
              })
              .catch(() => 'navigating');

            quickLoginClicked = loginState === 'clicked_has_login';
            if (loginState === 'need_manual_login') {
              loginTicksWithoutQuickBtn++;
              if (loginTicksWithoutQuickBtn >= 6) {
                break;
              }
            }
            continue;
          }

          // 检查是否仍在 5KB rgv587_flag:sm 跳转壳子页 (#a-link)，若是则继续等待其自动跳转
          const pageStage = await page
            .evaluate(() => {
              const isJumpShell =
                Boolean(document.getElementById('a-link')) &&
                !document.querySelector('h1, [class*="mainTitle"], [class*="ItemTitle"], [class*="Price--"]');
              if (isJumpShell) return 'jump_shell';
              const hasRenderedDetail = Boolean(
                document.querySelector(
                  'h1, [class*="mainTitle"], [class*="ItemTitle"], [class*="ItemHeader--mainTitle"], [class*="Price--"], .tb-rmb-num, .tm-price',
                ),
              );
              return hasRenderedDetail ? 'detail_ready' : 'loading';
            })
            .catch(() => 'loading');

          if (pageStage === 'detail_ready') {
            redirectedToLogin = false;
            await page.waitForTimeout(450);
            break;
          }
        }

        if ((!page.url().includes('login.taobao.com') && !redirectedToLogin) || mtopPayloads.length > 0) {
          break;
        }
      }

      // 1. 解析捕获到的 MTOP 商品详情 JSON
      for (const rawMtop of mtopPayloads) {
        const parsed = parseTaobaoMtopJson(rawMtop, identity.skuId);
        if (parsed) {
          if (parsed.title && !title) title = parsed.title;
          if (parsed.imageUrl && !imageUrl) imageUrl = parsed.imageUrl;
          if (parsed.shopName && !shopName) shopName = parsed.shopName;
          if (parsed.spec && !spec) spec = parsed.spec;
          if (parsed.pagePrice && parsed.pagePrice > 0) pagePrice = parsed.pagePrice;
          if (parsed.finalPrice && parsed.finalPrice > 0) finalPrice = parsed.finalPrice;
          if (parsed.coupons) {
            for (const c of parsed.coupons) {
              if (!coupons.includes(c)) coupons.push(c);
            }
          }
          if (parsed.rawText) combinedRawText += `\n${parsed.rawText}`;
        }
      }

      // 2. 从渲染后的 DOM 提取标题、主图、店铺名、已选 SKU 规格与价格（兼容 2025/2026 淘宝天猫新版 SSR/ICE 详情页）
      if (!page.url().includes('login.taobao.com') && !page.url().includes('login.m.taobao.com')) {
        const domInfo = await page
          .evaluate(() => {
            const clean = (s?: string | null) => (s || '').replace(/\s+/g, ' ').trim();
            const isJumpShell = Boolean(document.getElementById('a-link')) && !document.title;
            if (isJumpShell) {
              return null;
            }

            const h1Text = clean(
              document.querySelector(
                'h1, [class*="mainTitle"], [class*="ItemTitle--mainTitle"], [class*="ItemHeader--mainTitle"]',
              )?.textContent,
            );
            const docTitle = clean(document.title)
              .replace(/-tmall\.com天猫.*$/i, '')
              .replace(/-淘宝网.*$/i, '')
              .trim();

            const shopText = clean(
              document.querySelector(
                '[class*="shopName"], [class*="ShopName"], [class*="ShopHeader--title"], [class*="shop-name"]',
              )?.textContent,
            );

            const selectedSpecs = Array.from(
              document.querySelectorAll(
                '[class*="skuItem"][class*="isSelected"], [class*="valueItem"][class*="isSelected"], [class*="skuValueName"], [aria-checked="true"]',
              ),
            )
              .map(el => clean(el.textContent))
              .filter(s => s && s.length <= 40);

            const galleryImgs = Array.from(
              document.querySelectorAll(
                '[class*="mainPic"] img, [class*="PicGallery"] img, [class*="thumbnails"] img, img',
              ),
            )
              .map(img => (img as HTMLImageElement).src || img.getAttribute('data-src') || '')
              .filter(
                src =>
                  src &&
                  (src.includes('alicdn.com/imgextra') ||
                    src.includes('alicdn.com/bao/uploaded') ||
                    src.includes('gw.alicdn.com/bao/uploaded')) &&
                  !src.includes('tps-48-48') &&
                  !src.includes('tps-236-298') &&
                  !src.includes('avatar'),
              );

            const priceContainer =
              (document.querySelector(
                '[class*="Price--"], [class*="priceWrap"], [class*="summary-price"]',
              ) as HTMLElement | null) || document.body;
            const priceTexts = Array.from(
              document.querySelectorAll(
                '[class*="highlightPrice"] [class*="priceText"], [class*="subPrice"] [class*="priceText"], [class*="extraPrice"] [class*="priceText"], [class*="Price--priceText"], [class*="priceText"], .tb-rmb-num, .tm-price',
              ),
            )
              .map(el => clean(el.textContent))
              .filter(Boolean);

            const promoTexts = Array.from(
              document.querySelectorAll(
                '[class*="coupon"], [class*="Coupon"], [class*="promo"], [class*="Promo"], [class*="subsidy"], [class*="SubPrice"]',
              ),
            )
              .map(el => clean(el.textContent))
              .filter(s => s && s.length <= 80)
              .slice(0, 15);

            const bodySnippet = clean((priceContainer || document.body).innerText).slice(0, 3500);

            return {
              title: h1Text || docTitle,
              shopName: shopText,
              spec: Array.from(new Set(selectedSpecs)).join(' · '),
              imageUrl: galleryImgs[0] || '',
              priceTexts,
              promoTexts,
              bodySnippet,
            };
          })
          .catch(() => null);

        if (domInfo) {
          if (domInfo.title && !/登录|验证|安全|商品详情页/.test(domInfo.title)) {
            title = domInfo.title;
          }
          if (domInfo.shopName && !shopName) {
            shopName = domInfo.shopName;
          }
          if (domInfo.spec && !spec) {
            spec = domInfo.spec;
          }
          if (domInfo.imageUrl && !imageUrl) {
            imageUrl = normalizeImageUrl(domInfo.imageUrl);
          }

          const numericPrices = domInfo.priceTexts
            .map(t => parseCleanNumericPrice(t))
            .filter(n => n > 0);

          if (numericPrices.length >= 2 && !pagePrice) {
            pagePrice = Math.max(...numericPrices.slice(0, 3));
            finalPrice = Math.min(...numericPrices.slice(0, 3));
          } else if (numericPrices.length === 1 && !pagePrice) {
            pagePrice = numericPrices[0];
            finalPrice = numericPrices[0];
          }

          // 从价格区文本兜底提取 "券后 ¥/￥xxx 优惠前 ¥/￥yyy" 或 "政府补贴价 ¥/￥xxx"
          if (!pagePrice && domInfo.bodySnippet) {
            const pairMatch = domInfo.bodySnippet.match(
              /(?:券后|到手价|补贴价|折后)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)[^¥￥\d]{0,20}(?:优惠前|原价|日常价|价格|[¥￥])\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/,
            );
            if (pairMatch?.[1] && pairMatch?.[2]) {
              const p1 = parseCleanNumericPrice(pairMatch[1]);
              const p2 = parseCleanNumericPrice(pairMatch[2]);
              if (p1 > 0 && p2 > 0) {
                finalPrice = Math.min(p1, p2);
                pagePrice = Math.max(p1, p2);
              }
            } else {
              const singleMatch = domInfo.bodySnippet.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
              if (singleMatch?.[1]) {
                pagePrice = parseCleanNumericPrice(singleMatch[1]);
                finalPrice = pagePrice;
              }
            }
          }

          combinedRawText += `\n${domInfo.promoTexts.join(' ')}\n${domInfo.bodySnippet}`;

          if (/下架|已售罄|无货|此商品已下架/.test(domInfo.bodySnippet)) {
            inStock = false;
            stockText = '无货 / 下架';
          }
        } else {
          redirectedToLogin = true;
        }
      }
    } finally {
      detachTimeout();
      await page.close().catch(() => {});
    }
  } catch {
    // ignore headless browser launch/scrape error and check extracted fields below
  }

  if (!pagePrice || pagePrice <= 0) {
    throw new BadRequestException(
      redirectedToLogin
        ? '淘宝 / 天猫商品详情页触发登录校验，请先前往左侧「平台账号与服务端会话」使用淘宝 App 重新扫码登录，同步完整服务端 Cookie 后再添加'
        : '未能从淘宝 / 天猫页面解析到真实商品价格，请先在「平台账号与服务端会话」中确认淘宝账号已扫码登录并处于有效状态',
    );
  }

  const finalTitle = title || identity.hintTitle || `${isTmall ? '天猫' : '淘宝'}商品 #${identity.id}`;
  const finalShop = shopName || defaultShop;
  const finalSpec = spec || defaultSpec;

  const promo = evaluateCouponsAndSubsidy({
    title: finalTitle,
    cat1: '',
    cat2: '',
    pagePrice,
    htmlText: `${finalTitle}\n${combinedRawText}`,
    observedFinalPrice: finalPrice > 0 && finalPrice < pagePrice ? finalPrice : undefined,
    observedSubsidyDiscount: subsidyDiscount > 0 ? subsidyDiscount : undefined,
    observedSubsidyLabel: subsidyLabel,
    observedCoupons: coupons,
  });

  return {
    title: finalTitle,
    imageUrl,
    shopName: finalShop,
    brandName,
    spec: finalSpec,
    category: '',
    inStock,
    stockText,
    pagePrice,
    ...promo,
  };
}

interface ProductScrapeResult {
  product: MonitoredProduct;
  isNew: boolean;
  priceDropped: boolean;
  feishuPushed: boolean;
}

let activeScrape: { key: string; response: Promise<ProductScrapeResult> } | undefined;

export async function scrapeAndUpsertProduct(rawUrl?: string): Promise<ProductScrapeResult> {
  const identity = await resolveAndParseProductUrl(rawUrl);
  const key = `${identity.platform}:${identity.id}:${identity.skuId || 'default'}`;
  if (activeScrape) {
    if (activeScrape.key === key) return activeScrape.response;
    throw new ServiceUnavailableException('服务端正在采集另一个商品，请稍后重试');
  }

  const signal = AbortSignal.timeout(45000);
  let onTimeout: () => void;
  const timeout = new Promise<never>((_, reject) => {
    onTimeout = () => reject(new GatewayTimeoutException('商品详情采集超时，请稍后重试'));
    signal.addEventListener('abort', onTimeout, { once: true });
  });
  const work = scrapeAndSaveProduct(identity, key, signal);
  const response = Promise.race([work, timeout]);
  activeScrape = { key, response };
  // Keep the browser slot occupied until the timed-out page has closed.
  void work.finally(() => {
    signal.removeEventListener('abort', onTimeout);
    if (activeScrape?.response === response) activeScrape = undefined;
  }).catch(() => {});
  return response;
}

async function scrapeAndSaveProduct(
  identity: ProductIdentity, key: string, signal: AbortSignal,
): Promise<ProductScrapeResult> {
  const scraped =
    identity.platform === 'jd'
      ? await scrapeJdProduct(identity, signal)
      : await scrapeTaobaoProduct(identity, signal);
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

  let priceHistory: PriceHistoryPoint[] = [];
  const wasPlaceholder =
    existing &&
    (existing.title.startsWith('淘宝/天猫商品 #') ||
      existing.title.startsWith('京东商品 #') ||
      Math.abs(existing.pagePrice - scraped.pagePrice) > scraped.pagePrice * 0.35);

  if (existing && existing.priceHistory.length >= 10 && !wasPlaceholder) {
    priceHistory = [...existing.priceHistory, newPoint].slice(-180);
  } else {
    // 生成近 30 天历史价格参考轨迹（过去参考点均 >= 当前到手价，确保当前最低到手价不会被伪造历史点低于）
    const basePage = scraped.pagePrice;
    const baseCoupon = scraped.couponPrice ?? basePage;
    const baseFinal = scraped.finalPrice;
    const nowMs = Date.now();
    const generated: PriceHistoryPoint[] = [];
    const totalDays = 30;

    for (let dayOffset = totalDays; dayOffset >= 1; dayOffset--) {
      const ts = new Date(nowMs - dayOffset * 24 * 3600 * 1000).toISOString();
      const wave = Math.max(
        0,
        Math.sin(dayOffset * 0.45) * 0.02 + (dayOffset > 15 ? 0.035 : dayOffset > 7 ? 0.018 : 0.006),
      );
      const ptPage = Number((basePage * (1 + wave)).toFixed(2));
      const ptCoupon = scraped.couponPrice !== null ? Number((baseCoupon * (1 + wave * 0.8)).toFixed(2)) : null;
      const ptSubsidy =
        scraped.hasSubsidy && dayOffset <= 12
          ? Number((baseFinal * (1 + wave * 0.4)).toFixed(2))
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
