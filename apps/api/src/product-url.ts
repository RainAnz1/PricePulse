import { BadRequestException } from '@nestjs/common';

export interface ProductIdentity {
  platform: 'jd' | 'taobao';
  id: string;
  skuId: string | null;
  canonicalUrl: string;
  isTmall?: boolean;
  hintTitle?: string;
}

function cleanExtractedTitle(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/-tmall\.com天猫.*$/i, '')
    .replace(/-淘宝网.*$/i, '')
    .replace(/【图片\s*价格\s*品牌\s*评论】-京东.*$/i, '')
    .trim();
  return cleaned.length >= 2 ? cleaned : undefined;
}

export function parseProductUrl(input?: string, hintTitle?: string): ProductIdentity {
  if (!input || input.length > 4096) throw new BadRequestException('请输入有效的商品链接');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new BadRequestException('请输入完整的商品链接');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new BadRequestException('请输入标准商品链接');
  }
  const host = url.hostname.toLowerCase();
  const jd = host === 'item.jd.com';
  const mobileJd = host === 'item.m.jd.com' || host === 'wqitem.jd.com';
  const isTmall = host.endsWith('tmall.com') || host.endsWith('tmall.hk');
  const taobao =
    host === 'item.taobao.com' ||
    host === 'detail.tmall.com' ||
    host === 'chaoshi.detail.tmall.com' ||
    host === 'detail.tmall.hk' ||
    host === 'detail.m.tmall.com' ||
    host === 'h5.m.taobao.com' ||
    host === 'main.m.taobao.com' ||
    host === 'a.m.taobao.com' ||
    host === 'world.taobao.com';

  if (!jd && !mobileJd && !taobao) {
    throw new BadRequestException('请使用京东、淘宝或天猫的标准商品详情链接');
  }

  if (jd || mobileJd) {
    const id =
      url.pathname.match(/\/(\d+)\.html$/i)?.[1] ||
      url.searchParams.get('sku') ||
      url.searchParams.get('wareId') ||
      url.searchParams.get('id');
    if (!id || !/^[1-9]\d*$/.test(id)) throw new BadRequestException('无法识别京东商品 SKU ID');
    return {
      platform: 'jd',
      id,
      skuId: id,
      canonicalUrl: `https://item.jd.com/${id}.html`,
      hintTitle: cleanExtractedTitle(hintTitle),
    };
  }

  const id =
    url.searchParams.get('id') ||
    url.searchParams.get('itemId') ||
    url.pathname.match(/\/i(\d+)\.htm/i)?.[1] ||
    url.pathname.match(/\/item\/(\d+)\.htm/i)?.[1];
  const rawSkuId = url.searchParams.get('skuId') || url.searchParams.get('sku_id');
  const skuId = rawSkuId && /^[1-9]\d*$/.test(rawSkuId) ? rawSkuId : null;

  if (!id || !/^[1-9]\d*$/.test(id)) {
    throw new BadRequestException('无法识别淘宝或天猫商品 ID');
  }

  const canonical = new URL(`https://${isTmall ? 'detail.tmall.com' : 'item.taobao.com'}/item.htm?id=${id}`);
  if (skuId) canonical.searchParams.set('skuId', skuId);

  return {
    platform: 'taobao',
    id,
    skuId,
    canonicalUrl: canonical.toString(),
    isTmall,
    hintTitle: cleanExtractedTitle(hintTitle),
  };
}

export async function resolveAndParseProductUrl(rawInput?: string): Promise<ProductIdentity> {
  if (!rawInput || !rawInput.trim()) {
    throw new BadRequestException('请输入有效的商品链接');
  }

  const trimmed = rawInput.trim();
  const mdMatch = trimmed.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i);
  const bracketTitleMatch = trimmed.match(/「([^」]{2,120})」/);
  const hintTitle = cleanExtractedTitle(mdMatch?.[1] || bracketTitleMatch?.[1]);

  const rawUrlMatch = mdMatch?.[2] || trimmed.match(/https?:\/\/[^\s"'<>)\]]+/i)?.[0];
  const candidate = (rawUrlMatch || trimmed).replace(/[)\]'"]+$/, '');

  try {
    return parseProductUrl(candidate, hintTitle);
  } catch (directError) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate);
    } catch {
      throw directError;
    }
    const host = parsedUrl.hostname.toLowerCase();
    const isShortHost =
      host === '3.cn' ||
      host === 'u.jd.com' ||
      host === 'm.tb.cn' ||
      host === 'e.tb.cn' ||
      host === 'tb.cn' ||
      host === 's.click.taobao.com' ||
      host.endsWith('.jd.com') ||
      host.endsWith('.taobao.com') ||
      host.endsWith('.tmall.com') ||
      host.endsWith('.tmall.hk');
    if (!isShortHost) throw directError;

    try {
      const res = await fetch(candidate, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        },
      });
      if (res.url && res.url !== candidate) {
        try {
          return parseProductUrl(res.url, hintTitle);
        } catch {
          // continue inspecting HTML body for secondary redirect URL
        }
      }
      const html = await res.text();
      const htmlTitle = cleanExtractedTitle(html.match(/<title>([^<]+)<\/title>/i)?.[1]);
      const effectiveHint = hintTitle || (htmlTitle && !/登录|验证|跳转/.test(htmlTitle) ? htmlTitle : undefined);

      const hrlMatch =
        html.match(/hrl\s*=\s*['"](https?:\/\/[^'"]+)['"]/i) ||
        html.match(/var\s+url\s*=\s*['"](https?:\/\/[^'"]+)['"]/i) ||
        html.match(/location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i) ||
        html.match(/https?:\/\/item\.(?:m\.)?jd\.com\/(?:product\/)?\d+\.html/i) ||
        html.match(/https?:\/\/(?:detail\.tmall\.com|item\.taobao\.com)\/item\.htm\?[^"'\s<>]+/i) ||
        html.match(/https?:\/\/a\.m\.taobao\.com\/i\d+\.htm[^"'\s<>]*/i);
      if (hrlMatch) {
        const target = (hrlMatch[1] || hrlMatch[0]).replace(/&amp;/g, '&');
        return parseProductUrl(target, effectiveHint);
      }
    } catch {
      // fall through
    }
    throw directError;
  }
}

