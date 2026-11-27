import { Logger } from '@nestjs/common';
import type { Page } from 'playwright';

export interface CollectedProduct {
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
  finalPrice: number | null;
  coupons: string[];
  couponDiscount: number;
  hasSubsidy: boolean;
  subsidyLabel: string | null;
  subsidyDiscount: number;
}

export const productLogger = new Logger('ProductCollection');

export function closeProductPageOnTimeout(page: Page, signal: AbortSignal): () => void {
  const close = () => { void page.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  return () => signal.removeEventListener('abort', close);
}

export function parseCleanNumericPrice(raw?: string | number | null): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Number(raw.toFixed(2)) : 0;
  }
  if (!raw || typeof raw !== 'string') return 0;
  // 含有 ? 或字体混淆私用区字符 (U+E000..U+F8FF) 时视为掩码，绝不伪造数字
  if (raw.includes('?') || /[\uE000-\uF8FF]/.test(raw)) return 0;
  const match = raw.trim().match(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  if (!match?.[1]) return 0;
  const val = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(val) && val > 0 ? Number(val.toFixed(2)) : 0;
}

export function normalizeImageUrl(raw?: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return `https://img14.360buyimg.com/n1/${trimmed.replace(/^\/+/, '')}`;
}

export function evaluateCouponsAndSubsidy(params: {
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

  if (useObservedPriceOnly && hasExplicitSubsidyPrice && observedFinalPrice > 0) {
    return {
      coupons,
      couponDiscount: 0,
      couponPrice: null,
      hasSubsidy: true,
      subsidyLabel: observedSubsidyLabel || '国补领后价',
      subsidyDiscount: explicitSubsidyAmount,
      subsidyPrice: observedFinalPrice,
      finalPrice: observedFinalPrice,
    };
  }

  // 情况 A：页面明确采集到了真实国补价/到手价 + 国补立减金额（例如：日常价 ¥904，京东价 ¥844，国补减 ¥126.6，国补领后价 ¥717.4）
  if (observedFinalPrice > 0 && explicitSubsidyAmount > 0 && !useObservedPriceOnly) {
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
