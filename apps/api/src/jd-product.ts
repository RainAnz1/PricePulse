import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { jdOfferLabelKind, jdVisiblePriceShape, readJdDisplayedPrice, readJdPriceImage, resolveJdPrice } from './jd-price';
import {
  closeProductPageOnTimeout, evaluateCouponsAndSubsidy, normalizeImageUrl, parseCleanNumericPrice, productLogger,
} from './product-collection';
import type { CollectedProduct } from './product-collection';
import type { ProductIdentity } from './product-url';
import { getJdHeadlessContext, hasJdMobileAuth, loadPersistedJdSession } from './sessions';

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

interface JdRichDetail {
  pagePrice: number;
  finalPrice: number | null;
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

const jdCollectionMessages = {
  JD_RATE_LIMITED: '京东限制了商品页的访问频率，暂时无法读取价格。账号保活成功时也可能遇到商品页频控。',
  JD_VERIFICATION_REQUIRED: '京东商品页要求完成平台安全验证，暂时无法读取价格。',
  JD_LOGIN_REQUIRED: '京东商品页跳转到了登录页面，请重新扫码登录后重试。',
  JD_PRICE_ACCESS_DENIED: '京东拒绝了商品价格接口的请求，暂时无法读取价格。',
  JD_PRICE_UNAVAILABLE: '京东商品页没有返回可识别的价格，请稍后重试。',
} as const;
type JdCollectionCode = keyof typeof jdCollectionMessages;

function jdProductPageIssue(url: string): JdCollectionCode | null {
  if (!URL.canParse(url)) return null;
  const { hostname, pathname } = new URL(url);
  if (hostname === 'pc-frequent-pro.pf.jd.com' ||
      (hostname === 'trade.m.jd.com' && pathname === '/common/limit.html')) {
    return 'JD_RATE_LIMITED';
  }
  if (hostname === 'aq.jd.com' || hostname === 'safe.jd.com' || hostname === 'cfe.m.jd.com') {
    return 'JD_VERIFICATION_REQUIRED';
  }
  if (hostname === 'passport.jd.com' || hostname === 'plogin.m.jd.com') {
    return 'JD_LOGIN_REQUIRED';
  }
  return null;
}

async function scrapeJdPcRichDetail(
  skuId: string, signal: AbortSignal,
): Promise<JdRichDetail | JdCollectionCode | null> {
  let priceApiIssue: JdCollectionCode | null = null;
  try {
    const context = await getJdHeadlessContext();
    signal.throwIfAborted();
    const page = await context.newPage();
    const detachTimeout = closeProductPageOnTimeout(page, signal);
    let wareBusinessRaw = '';

    try {
      signal.throwIfAborted();
      page.on('response', async res => {
        const u = res.url();
        if (u.includes('pc_detailpage_wareBusiness')) {
          if (res.status() === 429) priceApiIssue = 'JD_RATE_LIMITED';
          else if (res.status() === 403 && !priceApiIssue) priceApiIssue = 'JD_PRICE_ACCESS_DENIED';
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
        const issue = jdProductPageIssue(page.url());
        if (issue) return issue;
        await page.waitForTimeout(250);
        const hasDomPrice = await page
          .evaluate((id: string) => {
            const txt =
              (document.querySelector('.summary-price-wrap') ||
                document.querySelector(`.J-p-${id}`) ||
                document.querySelector('.product-price-panel .product-price--main') ||
                document.querySelector('.p-price'))?.textContent || '';
            return /\d+(?:\.\d{1,2})?/.test(txt);
          }, skuId)
          .catch(() => false);
        if (hasDomPrice && (wareBusinessRaw || i >= 5)) break;
      }

      const pageIssue = jdProductPageIssue(page.url());
      if (pageIssue) return pageIssue;
      const domExtracted = await page.evaluate((id: string) => {
        const clean = (s?: string | null) => (s || '').replace(/\s+/g, ' ').trim();
        const pricePanel = document.querySelector('.product-price-panel');
        const mainPrice = pricePanel?.querySelector('.product-price--main');
        const mainPriceTag = mainPrice?.nextElementSibling;
        const labeledMainPrice = mainPriceTag?.matches('.product-price--activity-item--tag')
          ? `${clean(mainPrice?.textContent)} ${clean(mainPriceTag.textContent)}` : '';
        const priceWrapEl =
          (document.querySelector('.summary-price-wrap') as HTMLElement | null) ||
          (document.querySelector('.itemInfo-wrap') as HTMLElement | null);
        const priceAreaText = (priceWrapEl?.innerText || '').slice(0, 2500);
        const appliedDiscount = (document.querySelector('.page-right-discount') as HTMLElement | null)?.innerText
          ?.split('可再享')[0] || '';
        const quanAreaText = [clean(
          (document.querySelector('#summary-quan, .quan-item, .J-prom-quan') as HTMLElement | null)?.innerText,
        ), appliedDiscount].join('\n').slice(0, 1200);
        const jpText = clean(mainPrice?.textContent) || clean(document.querySelector(`.J-p-${id}`)?.textContent);
        const pPriceText = clean(document.querySelector('.p-price')?.textContent);
        const pageOriginPriceText = clean(
          (pricePanel?.querySelector('.product-price--gray') ||
            document.querySelector('#page_origin_price, .p-price-origin, .summary-price-wrap del'))?.textContent,
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
          labeledMainPrice,
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
      const displayed = readJdDisplayedPrice(`${domExtracted.labeledMainPrice ?? ''}\n${text}`);
      const displayedPrice = displayed.price || parseCleanNumericPrice(domExtracted.handPriceElText);
      if (displayedPrice > 0) {
        hasExplicitSubsidyPrice = displayed.subsidy;
        if (!displayed.subsidy) {
          subsidyDiscount = 0;
          subsidyLabel = null;
        }
      }
      if (hasExplicitSubsidyPrice) {
        const discount = `${text}\n${domExtracted.quanAreaText}`
          .match(/国家补贴\s*[|｜]?\s*(?:领后减|立减)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
        if (discount?.[1]) {
          subsidyDiscount = parseCleanNumericPrice(discount[1]);
          subsidyLabel = `国家补贴 | 领后减 ¥${subsidyDiscount}`;
        }
      }

      const jpVal = parseCleanNumericPrice(domExtracted.jpText || domExtracted.pPriceText);
      const domOriginVal = parseCleanNumericPrice(domExtracted.pageOriginPriceText);

      if (jpVal > 0 && !jdSellingPrice) jdSellingPrice = jpVal;
      if (domOriginVal > 0) originPrice = Math.max(originPrice, domOriginVal);

      const { pagePrice } = resolveJdPrice({
        displayed: displayedPrice,
        quotedOffer: explicitFinalPrice,
        selling: jdSellingPrice,
        original: originPrice,
      });

      const finalPrice = displayedPrice || explicitFinalPrice;
      if (finalPrice > 0 && pagePrice > finalPrice + 0.05 && !hasExplicitSubsidyPrice) {
        couponPrice = finalPrice;
      }

      if (pagePrice > 0 || finalPrice > 0) {
        return {
          pagePrice: pagePrice || finalPrice,
          finalPrice: finalPrice || null,
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
    signal.throwIfAborted();
  }
  return priceApiIssue;
}

async function scrapeJdMobileQuote(
  skuId: string, referencePrice: number, signal: AbortSignal,
): Promise<JdRichDetail | null> {
  try {
    const context = await getJdHeadlessContext();
    signal.throwIfAborted();
    const page = await context.newPage();
    const detachTimeout = closeProductPageOnTimeout(page, signal);
    const mobileUrl = new URL(`https://item.m.jd.com/product/${skuId}.html`);
    const onProduct = () => {
      const url = new URL(page.url());
      return url.origin === mobileUrl.origin && url.pathname === mobileUrl.pathname;
    };
    try {
      const response = await page.goto(mobileUrl.href, { waitUntil: 'domcontentloaded', timeout: 10500 });
      if (!response?.ok() || !onProduct()) return null;
      await page.locator('#priceSpec #defaultDesc + span').evaluate(
        value => value.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
        undefined,
        { timeout: 4000 },
      );
      await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 1500 });
      const quote = await page.evaluate(id => {
        const item = (window as Window & { _itemInfo?: { product?: { skuId?: string | number } } })._itemInfo;
        const label = document.querySelector<HTMLElement>('#priceSpec #defaultDesc');
        const value = label?.nextElementSibling as HTMLElement | null | undefined;
        if (String(item?.product?.skuId) !== id ||
            !label?.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ||
            !value?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
          return null;
        }
        const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
        let left = Infinity, top = Infinity, right = 0, bottom = 0;
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
          const start = node.data.search(/[\d\uE000-\uF8FF.,]/);
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, node.length);
          const r = range.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          left = Math.min(left, r.left);
          top = Math.min(top, r.top);
          right = Math.max(right, r.right);
          bottom = Math.max(bottom, r.bottom);
        }
        if (right <= left || bottom <= top) return null;
        // The product's floating recommendations can cover a price that is inside the viewport.
        const centerY = (top + bottom) / 2;
        if ([0.2, 0.5, 0.8].some(ratio => !value.contains(document.elementFromPoint(left + (right - left) * ratio, centerY)))) {
          return null;
        }
        const x = Math.max(0, Math.floor(left));
        const y = Math.max(0, Math.floor(top) - 4);
        const width = Math.min(innerWidth, Math.ceil(right) + 2) - x;
        const height = Math.min(innerHeight, Math.ceil(bottom) + 4) - y;
        if (width <= 0 || height <= 0 || width > 350 || height > 95) return null;
        return { label: label.innerText.trim(), text: value.innerText.trim(), clip: { x, y, width, height } };
      }, skuId);
      if (!quote || !onProduct()) return null;
      const kind = jdOfferLabelKind(quote.label);
      const shape = jdVisiblePriceShape(quote.text);
      if (!kind || !shape) return null;
      const plainPrice = /^(?:[¥￥]\s*)?\d[\d,.]*$/.test(quote.text) ? parseCleanNumericPrice(quote.text) : 0;
      const price = plainPrice || await readJdPriceImage(await page.screenshot({ clip: quote.clip, timeout: 3000 }), shape, signal);
      if (!price || !onProduct() || (referencePrice > 0 && price > referencePrice)) return null;
      return {
        pagePrice: referencePrice || price,
        finalPrice: price,
        couponPrice: 0,
        subsidyDiscount: 0,
        subsidyLabel: kind === 'subsidy' ? quote.label : null,
        hasExplicitSubsidyPrice: kind === 'subsidy',
        coupons: [],
        htmlText: '',
      };
    } finally {
      detachTimeout();
      await page.close().catch(() => {});
    }
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

export async function scrapeJdProduct(identity: ProductIdentity, signal: AbortSignal): Promise<CollectedProduct> {
  const startedAt = Date.now();
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
        // The page embeds a JavaScript object and may leave a trailing comma on the root object.
        itemInfo = JSON.parse(rawLiteral.replace(/,\s*}$/, '}')) as JdMobileItemInfo;
      } catch {
        // The desktop page can still provide a quote.
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

  // 优先读取已登录的手机商品页，缺少报价时沿用电脑端采集。
  const mobileQuote = hasJdMobileAuth(session?.cookies) && !session?.authExpiredAt
    ? await scrapeJdMobileQuote(skuId, mobilePrice, signal) : null;
  const pcResult = mobileQuote ? null : await scrapeJdPcRichDetail(skuId, signal);
  const quote = mobileQuote ?? (typeof pcResult === 'string' ? null : pcResult);
  if (quote?.title && title.startsWith('京东商品 #')) title = quote.title;
  if (quote?.shopName && shopName === '京东自营 / 官方旗舰店') shopName = quote.shopName;
  if (quote?.spec && spec === '默认规格') spec = quote.spec;

  const pagePrice = quote?.pagePrice || mobilePrice;
  if (!pagePrice || pagePrice <= 0) {
    const pcIssue = typeof pcResult === 'string' ? pcResult : null;
    const mobileIssue = jdProductPageIssue(res?.url ?? '') ??
      (res?.status === 429 ? 'JD_RATE_LIMITED' : res?.status === 403 ? 'JD_PRICE_ACCESS_DENIED' : null);
    const code = pcIssue === 'JD_RATE_LIMITED' || mobileIssue === 'JD_RATE_LIMITED'
      ? 'JD_RATE_LIMITED'
      : pcIssue ?? mobileIssue ?? 'JD_PRICE_UNAVAILABLE';
    productLogger.warn(JSON.stringify({
      event: 'jd_product_collection_failed',
      collectionId: randomUUID(),
      skuId,
      code,
      mobileStatus: res?.status ?? null,
      mobileIssue,
      pcIssue,
      elapsedMs: Date.now() - startedAt,
    }));
    throw new BadRequestException({ message: jdCollectionMessages[code], code });
  }

  const bannerText = [itemInfo.newBanner?.bannerName, itemInfo.newBanner?.fData?.bannerName, itemInfo.newBanner?.fData?.rightDownText]
    .filter(Boolean)
    .join(' ');
  const combinedText = `${quote?.htmlText || ''}\n${bannerText}`;
  const promo = evaluateCouponsAndSubsidy({
    title,
    cat1,
    cat2,
    pagePrice,
    htmlText: combinedText,
    observedFinalPrice: quote?.finalPrice ?? undefined,
    observedCouponPrice: quote?.couponPrice,
    observedSubsidyDiscount: quote?.subsidyDiscount,
    observedSubsidyLabel: quote?.subsidyLabel,
    observedCoupons: quote?.coupons,
    hasExplicitSubsidyPrice: quote?.hasExplicitSubsidyPrice,
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
    finalPrice: quote?.finalPrice ?? null,
  };
}
