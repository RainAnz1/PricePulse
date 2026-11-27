import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response as BrowserResponse } from 'playwright';
import {
  closeProductPageOnTimeout, evaluateCouponsAndSubsidy, normalizeImageUrl, parseCleanNumericPrice, productLogger,
} from './product-collection';
import type { CollectedProduct } from './product-collection';
import type { ProductIdentity } from './product-url';
import { getTaobaoHeadlessContext } from './sessions';
import { holdTaobaoVerification, isRequestedTaobaoPage, isTaobaoVerificationTitle, stopTaobaoVerificationCapture } from './taobao-verification';
import type { TaobaoVerification, verificationAccess } from './taobao-verification';

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

const taobaoCollectionMessages = {
  TAOBAO_VERIFICATION_REQUIRED: '淘宝商品页要求进行人机验证，暂时无法读取价格。账号已登录时也可能触发商品页验证。',
  TAOBAO_SESSION_EXPIRED: '淘宝商品接口提示登录已过期，请重新扫码登录后重试。',
  TAOBAO_LOGIN_REQUIRED: '淘宝商品页跳转到了登录页面，请重新扫码登录后重试。',
  TAOBAO_PRICE_UNAVAILABLE: '淘宝商品页没有返回可识别的价格，请确认该规格在售后重试。',
  TAOBAO_BROWSER_ERROR: '服务端浏览器未能完成淘宝商品采集，请稍后重试。',
} as const;
type TaobaoCollectionCode = keyof typeof taobaoCollectionMessages;

function isTaobaoLoginPage(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'login.taobao.com' || host === 'login.m.taobao.com';
}

export interface TaobaoCollectionOptions {
  access?: ReturnType<typeof verificationAccess>;
  resume?: TaobaoVerification;
}

export async function scrapeTaobaoProduct(
  identity: ProductIdentity, signal: AbortSignal, { access, resume }: TaobaoCollectionOptions,
): Promise<CollectedProduct> {
  const collectionId = randomUUID();
  const startedAt = Date.now();
  const collectionError = (code: TaobaoCollectionCode) => {
    productLogger.warn(JSON.stringify({
      event: 'taobao_product_collection_failed',
      collectionId,
      code,
      itemId: identity.id,
      skuId: identity.skuId,
      elapsedMs: Date.now() - startedAt,
    }));
    return new BadRequestException({ message: taobaoCollectionMessages[code], code });
  };
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
  let sessionExpired = false;

  try {
    if (resume) await stopTaobaoVerificationCapture(resume);
    const context = resume ? resume.page.context() : await getTaobaoHeadlessContext();
    signal.throwIfAborted();
    const page = resume?.page ?? await context.newPage();
    const detachTimeout = closeProductPageOnTimeout(page, signal);
    let held = false;
    const mtopPayloads = resume?.responses ?? [];
    let verificationRequired = false;
    const captureResponse = async (res: BrowserResponse) => {
      const url = new URL(res.url());
      if ((url.hostname !== 'h5api.m.taobao.com' && url.hostname !== 'h5api.m.tmall.com') ||
          !/^\/h5\/mtop\.taobao\.(?:pcdetail\.data\.get|detail\.(?:getdetail|data\.get))(?:\/|$)/i.test(url.pathname)) {
        return;
      }
      try {
        const text = await res.text();
        if (text.includes('SUCCESS::')) {
          mtopPayloads.push(text);
          if (mtopPayloads.length > 8) mtopPayloads.shift();
        } else if (text.includes('RGV587_ERROR')) {
          verificationRequired = true;
        } else if (text.includes('FAIL_SYS_SESSION_EXPIRED')) {
          sessionExpired = true;
        }
      } catch {
        // A response can disappear during navigation.
      }
    };
    const stopCapturing = () => { page.off('response', captureResponse); };

    try {
      signal.throwIfAborted();
      if (!resume) {
        page.on('popup', popup => { void popup.close().catch(() => {}); });
        await page.route('**/*', route => {
          const type = route.request().resourceType();
          return (type === 'image' && !access) || type === 'media' || type === 'font' ? route.abort() : route.fallback();
        });
      }
      page.on('response', captureResponse);
      let useCurrentDocument = Boolean(resume && isRequestedTaobaoPage(page.url(), identity) &&
        (!identity.skuId || new URL(page.url()).searchParams.get('skuId') === identity.skuId) &&
        !isTaobaoVerificationTitle(await page.title().catch(() => '')));

      const urlsToTry = new Set([
        identity.canonicalUrl,
        `https://item.taobao.com/item.htm?id=${identity.id}${identity.skuId ? `&skuId=${identity.skuId}` : ''}`,
      ]);

      for (const targetUrl of urlsToTry) {
        if (!useCurrentDocument) {
          await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
          }).catch(() => {});
        }
        useCurrentDocument = false;

        let loginTicksWithoutQuickBtn = 0;
        let quickLoginClicked = false;

        for (let i = 0; i < 24; i++) {
          await page.waitForTimeout(300);
          const pageState = await page.evaluate(() => {
            const priceElements = document.querySelectorAll(
              '[class*="highlightPrice"] [class*="priceText"], [class*="Price--priceText"], .tb-rmb-num, .tm-price',
            );
            return {
              title: document.title,
              priceReady: Array.from(priceElements).some(el => /\d/.test(el.textContent || '')),
            };
          }).catch(() => null);
          const hasChallengePage = isTaobaoVerificationTitle(pageState?.title);
          if (hasChallengePage || verificationRequired) {
            if (hasChallengePage && access) {
              signal.throwIfAborted();
              held = holdTaobaoVerification(access, identity, page, mtopPayloads, stopCapturing);
            }
            throw collectionError('TAOBAO_VERIFICATION_REQUIRED');
          }
          if (mtopPayloads.length > 0) {
            redirectedToLogin = false;
            sessionExpired = false;
            break;
          }

          if (isTaobaoLoginPage(page.url())) {
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

          if (pageState?.priceReady) {
            redirectedToLogin = false;
            sessionExpired = false;
            await page.waitForTimeout(450);
            break;
          }
        }

        if (verificationRequired) throw collectionError('TAOBAO_VERIFICATION_REQUIRED');
        if ((!isTaobaoLoginPage(page.url()) && !redirectedToLogin && !sessionExpired) || mtopPayloads.length > 0) {
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
      if (!isTaobaoLoginPage(page.url())) {
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
      if (!held) {
        stopCapturing();
        await page.close().catch(() => {});
      }
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    signal.throwIfAborted();
    if (!pagePrice) throw collectionError('TAOBAO_BROWSER_ERROR');
  }

  if (pagePrice <= 0) {
    if (sessionExpired) throw collectionError('TAOBAO_SESSION_EXPIRED');
    if (redirectedToLogin) throw collectionError('TAOBAO_LOGIN_REQUIRED');
    throw collectionError('TAOBAO_PRICE_UNAVAILABLE');
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
