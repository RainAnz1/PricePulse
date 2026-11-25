import { BadRequestException } from '@nestjs/common';

export interface ProductIdentity {
  platform: 'jd' | 'taobao';
  id: string;
  skuId: string | null;
  canonicalUrl: string;
}

export function parseProductUrl(input?: string): ProductIdentity {
  if (!input || input.length > 2048) throw new BadRequestException('请输入有效的商品链接');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new BadRequestException('请输入完整的商品链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new BadRequestException('请输入标准商品链接');
  const host = url.hostname.toLowerCase();
  const jd = host === 'item.jd.com';
  const taobao = host === 'item.taobao.com' || host === 'detail.tmall.com' || host === 'detail.m.tmall.com' || host === 'item.m.jd.com' || host === 'h5.m.taobao.com';
  const mobileJd = host === 'item.m.jd.com';
  if (!jd && !taobao) throw new BadRequestException('请使用京东、淘宝或天猫的标准商品详情链接');
  if (jd || mobileJd) {
    const id = jd ? url.pathname.match(/^\/(\d+)\.html$/)?.[1] : url.searchParams.get('sku');
    if (!id || !/^[1-9]\d*$/.test(id)) throw new BadRequestException('无法识别商品 ID');
    return { platform: 'jd', id, skuId: id, canonicalUrl: `https://item.jd.com/${id}.html` };
  }
  const id = url.searchParams.get('id');
  const skuId = url.searchParams.get('skuId');
  if (!id || !/^[1-9]\d*$/.test(id) || (skuId !== null && !/^[1-9]\d*$/.test(skuId))) throw new BadRequestException('无法识别商品 ID 或规格 ID');
  const canonical = new URL(`https://${host.endsWith('tmall.com') ? 'detail.tmall.com' : 'item.taobao.com'}/item.htm?id=${id}`);
  if (skuId) canonical.searchParams.set('skuId', skuId);
  return { platform: 'taobao', id, skuId, canonicalUrl: canonical.toString() };
}

export async function resolveAndParseProductUrl(rawInput?: string): Promise<ProductIdentity> {
  if (!rawInput || !rawInput.trim()) {
    throw new BadRequestException('请输入有效的商品链接');
  }
  const urlMatch = rawInput.trim().match(/https?:\/\/[^\s"'<>]+/i);
  const candidate = urlMatch ? urlMatch[0] : rawInput.trim();

  try {
    return parseProductUrl(candidate);
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
      host === 'tb.cn' ||
      host.endsWith('.jd.com') ||
      host.endsWith('.taobao.com') ||
      host.endsWith('.tmall.com');
    if (!isShortHost) throw directError;

    try {
      const res = await fetch(candidate, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        },
      });
      if (res.url && res.url !== candidate) {
        return parseProductUrl(res.url);
      }
      const html = await res.text();
      const hrlMatch = html.match(/hrl\s*=\s*['"](https?:\/\/[^'"]+)['"]/i) || html.match(/https?:\/\/item\.(?:m\.)?jd\.com\/(?:product\/)?\d+\.html/i);
      if (hrlMatch) {
        const target = hrlMatch[1] || hrlMatch[0];
        return parseProductUrl(target);
      }
    } catch {
      // fall through
    }
    throw directError;
  }
}
