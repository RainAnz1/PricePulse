import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  OnModuleInit,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { chromium, BrowserContext, Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Request } from 'express';
import { notifySessionExpiredToFeishu } from './feishu';

type Platform = 'jd' | 'taobao';

export interface StoredCookieItem {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface PersistedJdSession {
  platform: 'jd';
  pin: string;
  nickname: string;
  mobile?: string;
  cookies: Record<string, string>;
  cookieList?: StoredCookieItem[];
  cookieHeader: string;
  source: 'qrcode' | 'sms' | 'playwright';
  updatedAt: string;
  lastKeepAliveAt?: string;
  keepAliveCount?: number;
  protocolMeta?: {
    showEndpoint: string;
    checkEndpoint: string;
    validateEndpoint: string;
    verifyEndpoint: string;
    lastCheckCode?: number;
    lastValidateReturnCode?: number;
  };
}

interface ActiveJdQrSession {
  token: string;
  qrCodeKey: string;
  cookies: Record<string, string>;
  qrImage: string;
  createdAt: number;
  expiresAt: number;
  lastCode: number;
  lastMessage: string;
  ticket?: string;
}

const JD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JD_LOGIN_PAGE_URL = 'https://passport.jd.com/new/login.aspx';
const JD_QR_SHOW_URL = 'https://qr.m.jd.com/show';
const JD_QR_CHECK_URL = 'https://qr.m.jd.com/check';
const JD_QR_VALIDATE_URL = 'https://passport.jd.com/uc/qrCodeTicketValidation';
const JD_LOGIN_VERIFY_URL = 'https://passport.jd.com/loginservice.aspx';

const urls: Record<Platform, string> = { jd: 'https://www.jd.com/', taobao: 'https://www.taobao.com/' };
const contexts = new Map<Platform, BrowserContext>();
const launching = new Map<Platform, Promise<BrowserContext>>();

let activeJdQrSession: ActiveJdQrSession | null = null;
let headlessAuthContext: BrowserContext | null = null;
let headlessAuthLaunching: Promise<BrowserContext> | null = null;
let headlessLoginPage: Page | null = null;
let keepAliveTimer: NodeJS.Timeout | null = null;

/**
 * 统一解析到 Monorepo 根目录下的 .local-data，确保从根目录或 apps/api 启动时读写同一个持久化目录
 */
export function getDataRoot(): string {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { workspaces?: unknown };
        if (pkg.workspaces) {
          return join(dir, '.local-data');
        }
      } catch {
        // continue walking up
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), '.local-data');
}

export function getJdSessionFilePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'sessions', 'jd.json');
}

function getJdHeadlessProfilePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'browser-profiles', 'jd-headless');
}

function platformOf(value: string): Platform {
  if (value !== 'jd' && value !== 'taobao') throw new BadRequestException('不支持的平台');
  return value;
}

function validateOrigin(req: Request) {
  const origin = req.get('origin');
  if (!origin) return;
  if (origin !== 'http://127.0.0.1:8090' && origin !== 'http://localhost:8090') {
    throw new ForbiddenException('请从本地网站操作');
  }
}

export function parseSetCookieHeaders(setCookieHeaders: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    if (!header) continue;
    const firstPair = header.split(';')[0]?.trim();
    if (!firstPair) continue;
    const eqIdx = firstPair.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = firstPair.slice(0, eqIdx).trim();
    const val = firstPair.slice(eqIdx + 1).trim();
    if (key && val && val !== 'deleted' && val !== '""') {
      map[key] = val;
    }
  }
  return map;
}

export function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([k, v]) => Boolean(k && v))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function parseJsonpPayload<T = Record<string, unknown>>(rawText: string): T | null {
  const start = rawText.indexOf('(');
  const end = rawText.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(rawText.slice(start + 1, end)) as T;
  } catch {
    return null;
  }
}

function decodeCookieValue(raw?: string): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function loadPersistedJdSession(): PersistedJdSession | null {
  const filePath = getJdSessionFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as PersistedJdSession;
    if (!parsed || !parsed.cookies || Object.keys(parsed.cookies).length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePersistedJdSession(
  incoming: Partial<PersistedJdSession> & { cookies: Record<string, string> },
): PersistedJdSession {
  const existing = loadPersistedJdSession();
  const mergedCookies: Record<string, string> = {
    ...(existing?.cookies || {}),
    ...incoming.cookies,
  };

  const rawPin =
    incoming.pin ||
    decodeCookieValue(mergedCookies.pin || mergedCookies.pt_pin || mergedCookies.UseCorpPin) ||
    existing?.pin ||
    '';
  const rawNickname =
    incoming.nickname ||
    decodeCookieValue(mergedCookies.unick) ||
    existing?.nickname ||
    rawPin ||
    '京东用户';
  const pin = rawPin || rawNickname;
  const nickname = rawNickname || pin;

  const session: PersistedJdSession = {
    platform: 'jd',
    pin,
    nickname,
    mobile: incoming.mobile || existing?.mobile,
    cookies: mergedCookies,
    cookieList: incoming.cookieList || existing?.cookieList,
    cookieHeader: buildCookieHeader(mergedCookies),
    source: incoming.source || existing?.source || 'qrcode',
    updatedAt: incoming.updatedAt || new Date().toISOString(),
    lastKeepAliveAt: incoming.lastKeepAliveAt || existing?.lastKeepAliveAt || new Date().toISOString(),
    keepAliveCount: incoming.keepAliveCount ?? existing?.keepAliveCount ?? 0,
    protocolMeta: incoming.protocolMeta || existing?.protocolMeta,
  };

  const filePath = getJdSessionFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  return session;
}

export async function verifyJdCookiesWithLoginService(cookieHeader: string): Promise<{
  authenticated: boolean;
  pin: string;
  nickname: string;
  refreshedCookies: Record<string, string>;
}> {
  const refreshedCookies: Record<string, string> = {};
  try {
    const callback = `jsonpLogin_${Date.now()}`;
    const url = `${JD_LOGIN_VERIFY_URL}?method=Login&callback=${callback}&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': JD_UA,
        Referer: 'https://www.jd.com/',
        Cookie: cookieHeader,
      },
    });
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') || ''].filter(Boolean);
    Object.assign(refreshedCookies, parseSetCookieHeaders(setCookies));

    const text = await res.text();
    const parsed = parseJsonpPayload<{
      Identity?: { IsAuthenticated?: boolean; Unick?: string; Name?: string };
    }>(text);
    const identity = parsed?.Identity;
    if (identity?.IsAuthenticated) {
      return {
        authenticated: true,
        pin: identity.Name || '',
        nickname: identity.Unick || identity.Name || '',
        refreshedCookies,
      };
    }
  } catch {
    // ignore network error
  }
  return { authenticated: false, pin: '', nickname: '', refreshedCookies };
}

/**
 * 获取服务端常驻无头浏览器上下文（持久化 Profile + 自动注入已保存的 Cookie）
 * 用于执行京东 h5st 签名、Ticket 校验、短信验证码发送与登录，以及带登录态的商品价格采集
 */
export async function getJdHeadlessContext(): Promise<BrowserContext> {
  if (headlessAuthContext) return headlessAuthContext;
  if (headlessAuthLaunching) return headlessAuthLaunching;

  const task = (async () => {
    const profileDir = getJdHeadlessProfilePath();
    mkdirSync(profileDir, { recursive: true });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless: true,
        userAgent: JD_UA,
        viewport: { width: 1280, height: 800 },
      });
    } catch {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        userAgent: JD_UA,
        viewport: { width: 1280, height: 800 },
      });
    }

    const existing = loadPersistedJdSession();
    if (existing) {
      try {
        const toAdd =
          existing.cookieList && existing.cookieList.length > 0
            ? existing.cookieList.map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain || '.jd.com',
                path: c.path || '/',
              }))
            : Object.entries(existing.cookies).map(([name, value]) => ({
                name,
                value: String(value),
                domain: '.jd.com',
                path: '/',
              }));
        if (toAdd.length > 0) {
          await context.addCookies(toAdd);
        }
      } catch {
        // ignore cookie injection warnings
      }
    }

    headlessAuthContext = context;
    context.on('close', () => {
      if (headlessAuthContext === context) {
        headlessAuthContext = null;
        headlessLoginPage = null;
      }
    });
    return context;
  })();

  headlessAuthLaunching = task;
  try {
    return await task;
  } finally {
    headlessAuthLaunching = null;
  }
}

async function getOrOpenHeadlessJdLoginPage(): Promise<Page> {
  const context = await getJdHeadlessContext();
  if (headlessLoginPage && !headlessLoginPage.isClosed()) {
    const currentUrl = headlessLoginPage.url();
    if (currentUrl.includes('passport.jd.com')) {
      return headlessLoginPage;
    }
  }

  const page = await context.newPage();
  await page.goto(`${JD_LOGIN_PAGE_URL}?ReturnUrl=${encodeURIComponent('https://www.jd.com/')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 25000,
  });
  await page.waitForTimeout(800);
  headlessLoginPage = page;
  return page;
}

async function syncCookiesFromHeadlessContext(
  extraCookies: Record<string, string> = {},
  source: 'qrcode' | 'sms' = 'qrcode',
  extraMeta?: { mobile?: string; lastCheckCode?: number; lastValidateReturnCode?: number },
): Promise<PersistedJdSession> {
  const context = await getJdHeadlessContext();
  const browserCookies = await context.cookies(['https://www.jd.com', 'https://passport.jd.com', 'https://item.jd.com', 'https://m.jd.com']);
  const cookieMap: Record<string, string> = { ...extraCookies };
  const cookieList: StoredCookieItem[] = [];

  for (const c of browserCookies) {
    if (c.name && c.value && c.value !== 'deleted') {
      cookieMap[c.name] = c.value;
      cookieList.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
      });
    }
  }

  const header = buildCookieHeader(cookieMap);
  const verified = await verifyJdCookiesWithLoginService(header);
  Object.assign(cookieMap, verified.refreshedCookies);

  const pin =
    verified.pin ||
    decodeCookieValue(cookieMap.pin || cookieMap.pt_pin || cookieMap.UseCorpPin) ||
    extraMeta?.mobile ||
    '';
  const nickname =
    verified.nickname ||
    decodeCookieValue(cookieMap.unick) ||
    pin ||
    '京东用户';

  return savePersistedJdSession({
    pin,
    nickname,
    mobile: extraMeta?.mobile,
    cookies: cookieMap,
    cookieList,
    source,
    updatedAt: new Date().toISOString(),
    lastKeepAliveAt: new Date().toISOString(),
    protocolMeta: {
      showEndpoint: JD_QR_SHOW_URL,
      checkEndpoint: JD_QR_CHECK_URL,
      validateEndpoint: JD_QR_VALIDATE_URL,
      verifyEndpoint: JD_LOGIN_VERIFY_URL,
      lastCheckCode: extraMeta?.lastCheckCode,
      lastValidateReturnCode: extraMeta?.lastValidateReturnCode,
    },
  });
}

/**
 * 服务端定时保活任务：定期刷新京东会话状态并合并最新 Set-Cookie，防止长期放置后过期
 */
export async function runJdSessionKeepAlive(): Promise<{
  ok: boolean;
  session: PersistedJdSession | null;
  message: string;
}> {
  const session = loadPersistedJdSession();
  if (!session) {
    return { ok: false, session: null, message: '尚未保存京东登录态' };
  }

  const verified = await verifyJdCookiesWithLoginService(session.cookieHeader);
  const mergedCookies = {
    ...session.cookies,
    ...verified.refreshedCookies,
  };

  try {
    const homeRes = await fetch('https://www.jd.com/', {
      headers: {
        'User-Agent': JD_UA,
        Cookie: buildCookieHeader(mergedCookies),
      },
    });
    const setCookies =
      typeof homeRes.headers.getSetCookie === 'function'
        ? homeRes.headers.getSetCookie()
        : [homeRes.headers.get('set-cookie') || ''].filter(Boolean);
    Object.assign(mergedCookies, parseSetCookieHeaders(setCookies));
  } catch {
    // ignore transient network failure
  }

  const updated = savePersistedJdSession({
    ...session,
    pin: verified.pin || session.pin,
    nickname: verified.nickname || session.nickname,
    cookies: mergedCookies,
    updatedAt: session.updatedAt,
    lastKeepAliveAt: new Date().toISOString(),
    keepAliveCount: (session.keepAliveCount ?? 0) + 1,
  });

  return {
    ok: true,
    session: updated,
    message: `服务端保活完成（账号：${updated.nickname}，累计保活 ${updated.keepAliveCount} 次）`,
  };
}

async function open(platform: Platform): Promise<BrowserContext> {
  const active = contexts.get(platform);
  if (active) return active;
  const pending = launching.get(platform);
  if (pending) return pending;
  const operation = (async () => {
    const profile = join(getDataRoot(), 'PriceDrop', 'browser-profiles', platform);
    const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: false });
    contexts.set(platform, context);
    context.on('close', () => {
      if (contexts.get(platform) === context) contexts.delete(platform);
    });
    return context;
  })();
  launching.set(platform, operation);
  try {
    return await operation;
  } finally {
    launching.delete(platform);
  }
}

@Controller('sessions')
export class SessionsController implements OnModuleInit {
  onModuleInit() {
    if (!keepAliveTimer) {
      // 每 10 分钟在服务端后台执行一次京东登录态保活心跳
      keepAliveTimer = setInterval(() => {
        void runJdSessionKeepAlive();
      }, 10 * 60 * 1000);
      keepAliveTimer.unref?.();
    }
  }

  /**
   * 1. 获取京东网页扫码登录二维码 (直连 https://qr.m.jd.com/show)
   * 注意：获取新二维码时不会覆盖或清除已保存的 jd.json 登录态
   */
  @Post('jd/qrcode/start')
  async startJdQrCode(@Req() req: Request) {
    validateOrigin(req);
    const now = Date.now();
    const showUrl = `${JD_QR_SHOW_URL}?appid=133&size=147&t=${now}`;
    const res = await fetch(showUrl, {
      headers: {
        'User-Agent': JD_UA,
        Referer: JD_LOGIN_PAGE_URL,
      },
    });
    if (!res.ok) {
      throw new InternalServerErrorException('获取京东登录二维码失败，请稍后重试');
    }

    const rawSetCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') || ''].filter(Boolean);
    const cookies = parseSetCookieHeaders(rawSetCookies);
    const token = cookies.wlfstk_smdl;
    const qrCodeKey = cookies.QRCodeKey;

    if (!token || !qrCodeKey) {
      throw new InternalServerErrorException('京东二维码接口未返回有效的 wlfstk_smdl 或 QRCodeKey');
    }

    const imageBuffer = Buffer.from(await res.arrayBuffer());
    const qrImage = `data:image/png;base64,${imageBuffer.toString('base64')}`;

    activeJdQrSession = {
      token,
      qrCodeKey,
      cookies,
      qrImage,
      createdAt: now,
      expiresAt: now + 120_000,
      lastCode: 201,
      lastMessage: '二维码未扫描，请使用京东 App 扫码登录',
    };

    return {
      state: 'qr_ready',
      qrImage,
      token,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(activeJdQrSession.expiresAt).toISOString(),
      protocol: {
        showUrl,
        checkUrl: `${JD_QR_CHECK_URL}?appid=133&token=${token}`,
        validateUrl: JD_QR_VALIDATE_URL,
      },
      message: '请打开手机京东 App 扫描下方二维码登录',
    };
  }

  /**
   * 2. 轮询京东二维码扫码状态 (https://qr.m.jd.com/check)
   * 当 code === 200 时，在服务端无头上下文内完成 h5st 签名与 Ticket 校验，并将完整 Cookie 永久落盘
   */
  @Get('jd/qrcode/status')
  async checkJdQrStatus(@Req() req: Request) {
    validateOrigin(req);
    if (!activeJdQrSession) {
      return {
        state: 'qr_none',
        code: 0,
        message: '当前没有进行中的扫码会话',
      };
    }

    if (Date.now() > activeJdQrSession.expiresAt) {
      return {
        state: 'qr_expired',
        code: 203,
        message: '二维码已超时失效，请点击刷新重新获取二维码',
      };
    }

    const callback = `jQuery${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;
    const checkUrl = `${JD_QR_CHECK_URL}?callback=${callback}&appid=133&token=${encodeURIComponent(
      activeJdQrSession.token,
    )}&_=${Date.now()}`;

    const checkRes = await fetch(checkUrl, {
      headers: {
        'User-Agent': JD_UA,
        Referer: JD_LOGIN_PAGE_URL,
        Cookie: buildCookieHeader(activeJdQrSession.cookies),
      },
    });

    const rawText = await checkRes.text();
    const checkSetCookies =
      typeof checkRes.headers.getSetCookie === 'function'
        ? checkRes.headers.getSetCookie()
        : [checkRes.headers.get('set-cookie') || ''].filter(Boolean);
    Object.assign(activeJdQrSession.cookies, parseSetCookieHeaders(checkSetCookies));

    const payload = parseJsonpPayload<{ code?: number; msg?: string; ticket?: string }>(rawText);
    if (!payload || typeof payload.code !== 'number') {
      return {
        state: 'qr_error',
        code: -1,
        rawText,
        message: '解析京东扫码状态响应失败',
      };
    }

    activeJdQrSession.lastCode = payload.code;
    activeJdQrSession.lastMessage = payload.msg || '';

    switch (payload.code) {
      case 201:
        return {
          state: 'qr_waiting',
          code: 201,
          raw: payload,
          message: payload.msg || '等待扫码（请打开手机京东 App 扫一扫）',
        };
      case 202:
        return {
          state: 'qr_scanned',
          code: 202,
          raw: payload,
          message: payload.msg || '扫描成功！请在手机京东 App 上点击「确认登录」',
        };
      case 203:
      case 204:
        return {
          state: 'qr_expired',
          code: payload.code,
          raw: payload,
          message: payload.msg || '二维码已失效，请点击刷新二维码',
        };
      case 205:
        return {
          state: 'qr_cancelled',
          code: 205,
          raw: payload,
          message: payload.msg || '已在手机端取消二维码登录',
        };
      case 200: {
        const ticket = payload.ticket;
        if (!ticket) {
          return {
            state: 'qr_error',
            code: 200,
            raw: payload,
            message: '扫码已确认，但未获取到登录 ticket',
          };
        }

        activeJdQrSession.ticket = ticket;
        const qrCookiesSnapshot = { ...activeJdQrSession.cookies };
        let valJson: { returnCode?: number; url?: string } = {};

        // 优先在服务端无头浏览器页面中执行带真实 h5st / _stk 签名的 qrCodeTicketValidation
        try {
          const context = await getJdHeadlessContext();
          await context.addCookies(
            Object.entries(qrCookiesSnapshot).map(([name, value]) => ({
              name,
              value,
              domain: '.jd.com',
              path: '/',
            })),
          );
          const page = await getOrOpenHeadlessJdLoginPage();
          valJson = await page.evaluate(async (tk: string) => {
            const w = window as unknown as {
              paramsSingUtils?: (p: { t: string }) => Promise<{ h5st?: string; _stk?: string }>;
              getAliveSsoDomains?: () => string[];
            };
            let h5st = '';
            let _stk = '';
            if (typeof w.paramsSingUtils === 'function') {
              try {
                const signed = await w.paramsSingUtils({ t: tk });
                h5st = signed?.h5st || '';
                _stk = signed?._stk || '';
              } catch {
                // fallback
              }
            }
            const ssoDomains = typeof w.getAliveSsoDomains === 'function' ? w.getAliveSsoDomains().join(',') : '';
            const qs = new URLSearchParams({
              t: tk,
              pageSource: (document.querySelector('#pageSource') as HTMLInputElement)?.value || 'login2025',
              pageLocation: (document.querySelector('#pageLocation') as HTMLInputElement)?.value || '',
              ReturnUrl: 'https://www.jd.com/',
              h5st,
              _stk,
              firstShowAccountLoginPage:
                (document.querySelector('#firstShowAccountLoginPage') as HTMLInputElement)?.value || '',
              ssoDomains,
            });
            const r = await fetch(`/uc/qrCodeTicketValidation?${qs.toString()}`, {
              credentials: 'include',
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            return (await r.json()) as { returnCode?: number; url?: string };
          }, ticket);

          if (valJson.url && valJson.returnCode === 0) {
            await page.goto(valJson.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          }
        } catch {
          // 降级为服务端直连校验
          const validateUrl = `${JD_QR_VALIDATE_URL}?t=${encodeURIComponent(
            ticket,
          )}&pageSource=commonLogin&pageLocation=&ReturnUrl=${encodeURIComponent('https://www.jd.com/')}`;
          const valRes = await fetch(validateUrl, {
            headers: {
              'User-Agent': JD_UA,
              Referer: JD_LOGIN_PAGE_URL,
              Cookie: buildCookieHeader(qrCookiesSnapshot),
              'X-Requested-With': 'XMLHttpRequest',
            },
          });
          const valSetCookies =
            typeof valRes.headers.getSetCookie === 'function'
              ? valRes.headers.getSetCookie()
              : [valRes.headers.get('set-cookie') || ''].filter(Boolean);
          Object.assign(qrCookiesSnapshot, parseSetCookieHeaders(valSetCookies));
          try {
            valJson = (await valRes.json()) as { returnCode?: number; url?: string };
          } catch {
            // ignore
          }
        }

        const saved = await syncCookiesFromHeadlessContext(qrCookiesSnapshot, 'qrcode', {
          lastCheckCode: 200,
          lastValidateReturnCode: valJson.returnCode ?? 0,
        });

        activeJdQrSession = null;

        return {
          state: 'logged_in',
          code: 200,
          nickname: saved.nickname,
          pin: saved.pin,
          source: saved.source,
          updatedAt: saved.updatedAt,
          lastKeepAliveAt: saved.lastKeepAliveAt,
          cookieCount: Object.keys(saved.cookies).length,
          storagePath: getJdSessionFilePath(),
          raw: {
            check: payload,
            validation: valJson,
          },
          message: `京东扫码登录成功（账号：${saved.nickname}），登录态已长期保存在服务端`,
        };
      }
      default:
        return {
          state: 'qr_error',
          code: payload.code,
          raw: payload,
          message: payload.msg || `二维码状态异常 (code: ${payload.code})`,
        };
    }
  }

  /**
   * 3. 京东手机号验证码登录 — 发送短信验证码 (/uc/mobile/sendMessage)
   */
  @Post('jd/sms/send')
  async sendJdSmsCode(@Body() body: { mobile?: string }, @Req() req: Request) {
    validateOrigin(req);
    const mobile = (body?.mobile || '').trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new BadRequestException('请输入有效的 11 位中国大陆手机号码');
    }

    const page = await getOrOpenHeadlessJdLoginPage();
    const sendResult = await page.evaluate(async (phone: string) => {
      const mobileInput = document.querySelector('#mobile-number') as HTMLInputElement | null;
      if (mobileInput) {
        mobileInput.value = phone;
        mobileInput.dispatchEvent(new Event('input', { bubbles: true }));
        mobileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const getVal = (sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value || '';
      const params = new URLSearchParams({
        source: getVal('#source'),
        eid: getVal('#eid'),
        uuid: getVal('#uuid'),
        mobile: phone,
        imageAuthCodeToken: '',
        firstShowAccountLoginPage: getVal('#firstShowAccountLoginPage'),
        pageSource: getVal('#pageSource') || 'login2025',
        pageLocation: getVal('#pageLocation'),
        graphicCaptchaSessionId: getVal('#graphicCaptchaSessionId'),
        graphicCaptchaJwtToken: getVal('#graphicCaptchaJwtToken'),
      });

      const res = await fetch(`https://passport.jd.com/uc/mobile/sendMessage?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      const json = (await res.json()) as { code?: number; msg?: string };
      return json;
    }, mobile);

    if (sendResult.code === 1) {
      return {
        ok: true,
        state: 'sms_sent',
        mobile,
        countdown: 60,
        raw: sendResult,
        message: sendResult.msg || `验证码已发送至 ${mobile}，请输入 6 位短信验证码`,
      };
    }

    throw new BadRequestException(
      sendResult.msg || '京东短信发送触发图形/滑块安全校验，请优先使用上方「京东扫码登录」直接扫码',
    );
  }

  /**
   * 4. 京东手机号验证码登录 — 提交验证码并完成登录态服务端持久化 (/uc/mobile/loginService)
   */
  @Post('jd/sms/login')
  async loginJdWithSms(@Body() body: { mobile?: string; code?: string }, @Req() req: Request) {
    validateOrigin(req);
    const mobile = (body?.mobile || '').trim();
    const code = (body?.code || '').trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new BadRequestException('请输入有效的 11 位手机号码');
    }
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('请输入 6 位数字短信验证码');
    }

    const page = await getOrOpenHeadlessJdLoginPage();
    const loginResult = await page.evaluate(
      async ({ phone, smsCode }: { phone: string; smsCode: string }) => {
        const w = window as unknown as {
          paramsSingUtils?: (p: { mobile: string }) => Promise<{ h5st?: string; _stk?: string }>;
          getAliveSsoDomains?: () => string[];
          _jdtdmap_sessionId?: string;
        };
        const getVal = (sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value || '';
        let h5st = '';
        let _stk = '';
        if (typeof w.paramsSingUtils === 'function') {
          try {
            const signed = await w.paramsSingUtils({ mobile: phone });
            h5st = signed?.h5st || '';
            _stk = signed?._stk || '';
          } catch {
            // ignore
          }
        }
        const ssoDomains = typeof w.getAliveSsoDomains === 'function' ? w.getAliveSsoDomains().join(',') : '';
        const formData = new URLSearchParams({
          uuid: getVal('#uuid'),
          eid: getVal('#eid'),
          eid2: getVal('#eid2'),
          fp: getVal('#sessionId'),
          _t: getVal('#token'),
          mobile: phone,
          mobileCode: smsCode,
          pageSource: getVal('#pageSource') || 'login2025',
          pageLocation: getVal('#pageLocation'),
          loginType: getVal('#loginType') || 'f',
          sa_token: getVal('#sa_token'),
          seqSid: w._jdtdmap_sessionId || '',
          useSlideAuthCode: getVal('#useRandomSlideAuthCode') || '1',
          authcode: document.querySelector('#sms-login-submit')?.getAttribute('data-code') || '',
          ssoDomains,
          h5st,
          _stk,
        });

        const res = await fetch(`https://passport.jd.com/uc/mobile/loginService?r=${Math.random()}&version=2015`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: formData.toString(),
        });
        const text = await res.text();
        return text;
      },
      { phone: mobile, smsCode: code },
    );

    let parsed: Record<string, string> = {};
    try {
      const cleaned = loginResult.trim().replace(/^\(/, '').replace(/\)$/, '');
      parsed = JSON.parse(cleaned) as Record<string, string>;
    } catch {
      throw new BadRequestException('解析京东短信登录响应失败，请重试或使用扫码登录');
    }

    if (parsed.success) {
      await page.goto(parsed.success, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      const saved = await syncCookiesFromHeadlessContext({}, 'sms', { mobile });
      activeJdQrSession = null;
      return {
        state: 'logged_in',
        nickname: saved.nickname,
        pin: saved.pin,
        mobile: saved.mobile,
        source: saved.source,
        updatedAt: saved.updatedAt,
        lastKeepAliveAt: saved.lastKeepAliveAt,
        cookieCount: Object.keys(saved.cookies).length,
        storagePath: getJdSessionFilePath(),
        message: `京东手机号验证码登录成功（账号：${saved.nickname}），登录态已长期保存在服务端`,
      };
    }

    const errMsg =
      parsed.mobileCode ||
      parsed.authcode2 ||
      parsed.emptyAuthcode ||
      parsed.username ||
      (parsed.newSafeVerify ? '该账号触发京东安全魔方二次验证，请使用上方「京东扫码登录」' : '') ||
      '验证码错误或已失效，请重新获取或使用扫码登录';
    throw new BadRequestException(errMsg);
  }

  /**
   * 5. 查询当前服务端已保存的京东登录态详情（刷新网页时调用，绝不主动清空有效会话）
   */
  @Get('jd/status')
  async getJdStatus() {
    const session = loadPersistedJdSession();
    if (!session) {
      return {
        state: 'login_required',
        message: '尚未保存京东登录态，请使用「京东扫码登录」或「手机号验证码登录」',
      };
    }

    const verified = await verifyJdCookiesWithLoginService(session.cookieHeader);
    if (Object.keys(verified.refreshedCookies).length > 0 || verified.authenticated) {
      const updated = savePersistedJdSession({
        ...session,
        pin: verified.pin || session.pin,
        nickname: verified.nickname || session.nickname,
        cookies: {
          ...session.cookies,
          ...verified.refreshedCookies,
        },
        updatedAt: session.updatedAt,
        lastKeepAliveAt: new Date().toISOString(),
      });
      return {
        state: 'logged_in',
        nickname: updated.nickname,
        pin: updated.pin,
        mobile: updated.mobile,
        source: updated.source,
        updatedAt: updated.updatedAt,
        lastKeepAliveAt: updated.lastKeepAliveAt,
        keepAliveCount: updated.keepAliveCount ?? 0,
        cookieCount: Object.keys(updated.cookies).length,
        storagePath: getJdSessionFilePath(),
        message: `京东登录态已长期保存在服务端（账号：${updated.nickname}，共 ${
          Object.keys(updated.cookies).length
        } 项 Cookie）`,
      };
    }

    const cookieCount = Object.keys(session.cookies).length;
    if (cookieCount > 0) {
      return {
        state: 'logged_in',
        nickname: session.nickname || session.pin || '京东已登录用户',
        pin: session.pin || session.nickname || 'jd_user',
        mobile: session.mobile,
        source: session.source,
        updatedAt: session.updatedAt,
        lastKeepAliveAt: session.lastKeepAliveAt,
        keepAliveCount: session.keepAliveCount ?? 0,
        cookieCount,
        storagePath: getJdSessionFilePath(),
        message: `京东登录态已长期保存在服务端（账号：${session.nickname || session.pin}，共 ${cookieCount} 项 Cookie）`,
      };
    }

    void notifySessionExpiredToFeishu('jd', '服务端京东 Cookie 已失效，请重新登录');
    return {
      state: 'login_required',
      message: '本地保存的京东登录态已失效，请重新登录',
    };
  }

  /**
   * 6. 手动触发一次服务端京东登录态保活刷新
   */
  @Post('jd/keepalive')
  async manualKeepAlive(@Req() req: Request) {
    validateOrigin(req);
    const res = await runJdSessionKeepAlive();
    if (!res.ok || !res.session) {
      throw new BadRequestException(res.message);
    }
    return {
      state: 'logged_in',
      nickname: res.session.nickname,
      pin: res.session.pin,
      source: res.session.source,
      updatedAt: res.session.updatedAt,
      lastKeepAliveAt: res.session.lastKeepAliveAt,
      keepAliveCount: res.session.keepAliveCount,
      cookieCount: Object.keys(res.session.cookies).length,
      storagePath: getJdSessionFilePath(),
      message: res.message,
    };
  }

  @Post(':platform/open')
  async open(@Param('platform') input: string, @Req() req: Request) {
    validateOrigin(req);
    const platform = platformOf(input);
    try {
      const context = await open(platform);
      const page = context.pages()[0] || (await context.newPage());
      if (page.url() === 'about:blank') {
        await page.goto(urls[platform], { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      await page.bringToFront();
      return { state: 'opened', message: '浏览器已打开，请在窗口中自行登录' };
    } catch {
      throw new InternalServerErrorException(
        '无法打开项目浏览器，请确认已安装 Microsoft Edge 且该平台的项目浏览器未被占用',
      );
    }
  }

  @Post(':platform/check')
  async check(@Param('platform') input: string, @Req() req: Request) {
    validateOrigin(req);
    const platform = platformOf(input);

    if (platform === 'jd') {
      const jdStatus = await this.getJdStatus();
      if (jdStatus.state === 'logged_in') {
        return jdStatus;
      }
    }

    const context = contexts.get(platform);
    if (!context) {
      return {
        state: 'unknown',
        message:
          platform === 'jd'
            ? '未检测到有效京东登录态，请使用「京东扫码登录」或「手机号验证码登录」'
            : '请先打开项目浏览器并登录',
      };
    }
    const page = context.pages().find(candidate => {
      try {
        const host = new URL(candidate.url()).hostname;
        const domain = platform === 'jd' ? 'jd.com' : 'taobao.com';
        return (
          host === domain ||
          host.endsWith('.' + domain) ||
          (platform === 'taobao' && (host === 'tmall.com' || host.endsWith('.tmall.com')))
        );
      } catch {
        return false;
      }
    });
    if (!page) return { state: 'unknown', message: '请在项目浏览器中打开对应平台页面' };
    try {
      const url = new URL(page.url());
      if (
        (platform === 'jd' && (url.hostname === 'passport.jd.com' || url.hostname.startsWith('login.'))) ||
        (platform === 'taobao' && url.hostname.startsWith('login.'))
      ) {
        return { state: 'login_required', message: '需要登录或登录状态已失效' };
      }
      const state = await page.evaluate(site => {
        const text = document.body?.innerText || '';
        if (/当前页面异常|请刷新或切换账户试试|请刷新或切换账号试试/.test(text)) return 'page_error';
        if (/滑块验证|安全验证|访问受限|验证码/.test(text)) return 'verification';
        if (/请登录|亲，请登录/.test(text)) return 'login_required';
        const link =
          site === 'jd'
            ? document.querySelector('a[href*="home.jd.com"]')
            : document.querySelector('#J_SiteNavBdL a[href*="i.taobao.com"]');
        return link ? 'logged_in' : 'unknown';
      }, platform);
      const messages = {
        page_error: '京东页面报告异常，请在项目浏览器中按页面提示操作；如持续出现，请联系京东客服',
        logged_in: '检测到登录状态，请再次检查以验证会话复用',
        login_required: '需要登录或登录状态已失效',
        verification: '平台要求验证，请在浏览器中处理',
        unknown: '无法可靠确认登录状态，请检查浏览器页面',
      };
      return { state, message: messages[state] };
    } catch {
      return { state: 'unknown', message: '检查失败，请确认网络和浏览器状态' };
    }
  }
}
