import { BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { BlockList, isIPv4 } from 'node:net';
import type { Request } from 'express';
import type { Page } from 'playwright';
import type { ProductIdentity } from './product-url';
import { RemoteBrowserControls } from './remote-browser-controls';

interface VerificationAccess {
  address: string;
  token: string;
}

export interface TaobaoVerification {
  access: VerificationAccess;
  identity: ProductIdentity;
  page: Page;
  responses: string[];
  stopCapturing: () => void;
  timeout: NodeJS.Timeout;
}

const tokenHeader = 'x-pricepulse-verification-token';
export const verificationBrowser = new RemoteBrowserControls<Page>();
let current: TaobaoVerification | undefined;

export function verificationAccess(req?: Request): VerificationAccess | undefined {
  const address = req?.socket?.remoteAddress?.replace(/^::ffff:/, '');
  const token = req?.get(tokenHeader);
  const cidr = process.env.PRICEPULSE_VERIFICATION_LAN_CIDR?.match(/^([\d.]+)\/(\d{1,2})$/);
  if (!req || !address || !isIPv4(address) || !cidr || !isIPv4(cidr[1]) || !token || !/^[a-f0-9]{32}$/.test(token)) {
    return;
  }
  const site = req.get('sec-fetch-site');
  const origin = req.get('origin');
  if ((site && site !== 'same-origin') ||
      (origin && origin !== `http://${req.get('host')}` && origin !== `https://${req.get('host')}`)) return;
  const prefix = Number(cidr[2]);
  if (prefix < 16 || prefix > 32) return;
  const allowed = new BlockList();
  allowed.addSubnet(cidr[1], prefix, 'ipv4');
  if (allowed.check(address, 'ipv4')) return { address, token };
}

export function isTaobaoVerificationTitle(title?: string): boolean {
  return /^(?:CAPTCHA Verification|安全验证|访问验证|人机验证)$/i.test(title?.trim() || '');
}

export function isRequestedTaobaoPage(url: string, identity: ProductIdentity): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && !parsed.port &&
    (parsed.hostname === 'item.taobao.com' || parsed.hostname === 'detail.tmall.com') &&
    parsed.pathname === '/item.htm' && parsed.searchParams.get('id') === identity.id;
}

export function holdTaobaoVerification(
  access: VerificationAccess, identity: ProductIdentity, page: Page, responses: string[], stopCapturing: () => void,
): boolean {
  if (current || !isRequestedTaobaoPage(page.url(), identity)) return false;
  const verification: TaobaoVerification = {
    access,
    identity,
    page,
    responses,
    stopCapturing,
    timeout: setTimeout(() => { void closeTaobaoVerification(verification); }, 180000),
  };
  verification.timeout.unref();
  current = verification;
  page.once('close', () => {
    if (current === verification) detachTaobaoVerification(verification);
    void verificationBrowser.clear(page);
  });
  return true;
}

export function ownedTaobaoVerification(access?: VerificationAccess): TaobaoVerification | undefined {
  if (current && access && current.access.address === access.address && current.access.token === access.token) {
    return current;
  }
}

export function requireTaobaoVerification(req: Request): TaobaoVerification {
  const access = verificationAccess(req);
  if (!access) throw new ForbiddenException('请从已授权的内网入口打开商品验证');
  const verification = ownedTaobaoVerification(access);
  if (!verification || verification.page.isClosed()) {
    throw new GoneException('商品验证窗口已过期，请重新添加商品');
  }
  return verification;
}

export function detachTaobaoVerification(verification: TaobaoVerification) {
  if (current === verification) current = undefined;
  clearTimeout(verification.timeout);
  verification.stopCapturing();
}

export async function closeTaobaoVerification(verification: TaobaoVerification) {
  detachTaobaoVerification(verification);
  await verificationBrowser.clear(verification.page);
  await verification.page.close().catch(() => {});
}

export async function checkTaobaoVerificationPage(verification: TaobaoVerification): Promise<boolean> {
  const { page, identity } = verification;
  if (current !== verification) throw new GoneException('商品验证窗口已关闭');
  if (!isRequestedTaobaoPage(page.url(), identity)) {
    await closeTaobaoVerification(verification);
    throw new BadRequestException('验证页面已离开该商品，请重新添加商品');
  }
  const title = await page.title();
  if (current !== verification || !isRequestedTaobaoPage(page.url(), identity)) {
    throw new GoneException('商品验证页面已关闭或跳转');
  }
  return isTaobaoVerificationTitle(title);
}
