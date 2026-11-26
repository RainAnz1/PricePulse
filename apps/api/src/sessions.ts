import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  InternalServerErrorException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { chromium, BrowserContext, Page } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Request } from 'express';
import { notifySessionExpiredToFeishu } from './feishu';
import { RemoteBrowserControls, RemotePointerInput } from './remote-browser-controls';

type Platform = 'jd' | 'taobao';

export interface StoredCookieItem {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
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
  hadValidAuth?: boolean;
  lastVerifiedAt?: string;
  authExpiredAt?: string;
  expiredNotifiedAt?: string;
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

interface ActiveTaobaoQrSession {
  expiresAt: number;
  lastStatus: 'NEW' | 'SCANED' | 'CONFIRMED' | 'EXPIRED' | 'CANCELED' | 'ERROR';
}

const accountDomains = {
  jd: /(?:^|\.)jd\.com$/i,
  taobao: /(?:^|\.)(?:taobao|tmall)\.com$/i,
};

const loginPages = {
  jd: 'https://passport.jd.com/new/login.aspx?ReturnUrl=https%3A%2F%2Fwww.jd.com%2F',
  taobao: 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&sub=true',
};

function platformUrl(value: string | undefined, platform: Platform, base = loginPages[platform]): URL | null {
  try {
    const url = new URL(value || '', base);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      accountDomains[platform].test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

const JD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JD_LOGIN_PAGE_URL = 'https://passport.jd.com/new/login.aspx';
const JD_QR_SHOW_URL = 'https://qr.m.jd.com/show';
const JD_QR_CHECK_URL = 'https://qr.m.jd.com/check';
const JD_QR_VALIDATE_URL = 'https://passport.jd.com/uc/qrCodeTicketValidation';
const JD_LOGIN_VERIFY_URL = 'https://passport.jd.com/loginservice.aspx';

const TB_LOGIN_PAGE_URL = loginPages.taobao;
const TB_QR_GENERATE_URL = 'https://login.taobao.com/havanaone/loginLegacy/qrCode/generate.do';
const TB_QR_QUERY_URL = 'https://login.taobao.com/havanaone/loginLegacy/qrCode/query.do';
const TB_SMS_SEND_URL = 'https://login.taobao.com/havanaone/loginLegacy/sms/sendSms.do';
const TB_SMS_LOGIN_URL = 'https://login.taobao.com/havanaone/loginLegacy/sms/login.do';

const urls: Record<Platform, string> = { jd: 'https://www.jd.com/', taobao: 'https://www.taobao.com/' };
const contexts = new Map<Platform, BrowserContext>();
const launching = new Map<Platform, Promise<BrowserContext>>();

let activeJdQrSession: ActiveJdQrSession | null = null;
let headlessAuthContext: BrowserContext | null = null;
let headlessAuthLaunching: Promise<BrowserContext> | null = null;
let headlessLoginPage: Page | null = null;

let activeTaobaoQrSession: ActiveTaobaoQrSession | null = null;
let headlessTbPage: Page | null = null;

let keepAliveTimer: NodeJS.Timeout | null = null;
let jdVerification: Promise<JdSessionCheck> | null = null;
const authVersion: Record<Platform, number> = { jd: 0, taobao: 0 };

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

export function getTaobaoSessionFilePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'sessions', 'taobao.json');
}

export interface PersistedTaobaoSession {
  platform: 'taobao';
  nick: string;
  uid: string;
  mobile?: string;
  cookies: Record<string, string>;
  cookieList?: StoredCookieItem[];
  cookieHeader: string;
  source?: 'qrcode' | 'sms' | 'playwright';
  updatedAt: string;
  lastKeepAliveAt?: string;
  keepAliveCount?: number;
  protocolMeta?: {
    generateEndpoint: string;
    queryEndpoint: string;
    sendSmsEndpoint: string;
    smsLoginEndpoint: string;
  };
}

export function loadPersistedTaobaoSession(): PersistedTaobaoSession | null {
  const filePath = getTaobaoSessionFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedTaobaoSession;
    if (!parsed || !parsed.cookies || Object.keys(parsed.cookies).length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePersistedTaobaoSession(
  incoming: Partial<PersistedTaobaoSession> & { cookies: Record<string, string> },
): PersistedTaobaoSession {
  const existing = loadPersistedTaobaoSession();
  const mergedCookies = incoming.cookies;
  const rawNick =
    incoming.nick ||
    decodeCookieValue(mergedCookies.tracknick || mergedCookies._nk_ || mergedCookies.lgc || mergedCookies.dnk) ||
    existing?.nick ||
    incoming.mobile ||
    '淘宝用户';
  const rawUid =
    incoming.uid ||
    decodeCookieValue(mergedCookies.unb || mergedCookies.tracknick || mergedCookies.lgc) ||
    existing?.uid ||
    rawNick;

  const session: PersistedTaobaoSession = {
    platform: 'taobao',
    nick: rawNick,
    uid: rawUid,
    mobile: incoming.mobile || existing?.mobile,
    cookies: mergedCookies,
    cookieList: incoming.cookieList || existing?.cookieList,
    cookieHeader: buildCookieHeader(mergedCookies),
    source: incoming.source || existing?.source || 'qrcode',
    updatedAt: incoming.updatedAt || new Date().toISOString(),
    lastKeepAliveAt: incoming.lastKeepAliveAt || existing?.lastKeepAliveAt || new Date().toISOString(),
    keepAliveCount: incoming.keepAliveCount ?? existing?.keepAliveCount ?? 0,
    protocolMeta: incoming.protocolMeta ||
      existing?.protocolMeta || {
        generateEndpoint: TB_QR_GENERATE_URL,
        queryEndpoint: TB_QR_QUERY_URL,
        sendSmsEndpoint: TB_SMS_SEND_URL,
        smsLoginEndpoint: TB_SMS_LOGIN_URL,
      },
  };

  const filePath = getTaobaoSessionFilePath();
  writeSessionFile(filePath, session);
  return session;
}

function getSharedHeadlessProfilePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'browser-profiles', 'shared-headless');
}

function writeSessionFile(filePath: string, session: PersistedJdSession | PersistedTaobaoSession): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = filePath + '.tmp';
  writeFileSync(temporaryPath, JSON.stringify(session, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

function platformOf(value: string): Platform {
  if (value !== 'jd' && value !== 'taobao') throw new BadRequestException('不支持的平台');
  return value;
}

function validateOrigin(req: Request) {
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    throw new ForbiddenException('请从当前 PricePulse 页面发起请求');
  }
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) ||
        (fetchSite !== 'same-origin' && parsed.host !== req.get('host'))) {
      throw new ForbiddenException('非法的请求来源协议');
    }
  } catch {
    throw new ForbiddenException('非法的请求来源');
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
  try {
    return JSON.parse(rawText) as T;
  } catch {
    // Try the JSONP wrapper.
  }
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
  const mergedCookies = incoming.cookies;

  const rawPin =
    incoming.pin ||
    decodeCookieValue(
      mergedCookies.pin ||
        mergedCookies.pt_pin ||
        mergedCookies.pwdt_id ||
        mergedCookies.UseCorpPin,
    ) ||
    existing?.pin ||
    '';
  const rawNickname =
    (incoming.nickname && incoming.nickname !== '京东用户' ? incoming.nickname : '') ||
    decodeCookieValue(mergedCookies.unick) ||
    (existing?.nickname && existing.nickname !== '京东用户' ? existing.nickname : '') ||
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
    hadValidAuth: incoming.hadValidAuth ?? existing?.hadValidAuth,
    lastVerifiedAt: incoming.lastVerifiedAt ?? existing?.lastVerifiedAt,
    authExpiredAt: incoming.authExpiredAt,
    expiredNotifiedAt: incoming.expiredNotifiedAt,
    protocolMeta: incoming.protocolMeta || existing?.protocolMeta,
  };

  const filePath = getJdSessionFilePath();
  writeSessionFile(filePath, session);
  return session;
}

export async function verifyJdCookiesWithLoginService(cookieHeader: string): Promise<{
  authenticated: boolean;
  rejected: boolean;
  pin: string;
  nickname: string;
  refreshedCookies: Record<string, string>;
}> {
  const refreshedCookies: Record<string, string> = {};
  if (!cookieHeader) return { authenticated: false, rejected: false, pin: '', nickname: '', refreshedCookies };
  let authenticated = false;
  let rejected = false;
  let pin = '';
  let nickname = '';

  try {
    const callback = `jsonpLogin_${Date.now()}`;
    const url = `${JD_LOGIN_VERIFY_URL}?method=Login&callback=${callback}&_=${Date.now()}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      redirect: 'error',
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
    const identity = res.ok ? parsed?.Identity : undefined;
    rejected = identity?.IsAuthenticated === false;
    if (identity?.IsAuthenticated === true) {
      authenticated = true;
      pin = identity.Name || '';
      nickname = identity.Unick || identity.Name || '';
    }
  } catch {
    // ignore network error
  }

  // 若 loginservice.aspx 未返回昵称或在小服务器上受限，使用京东用户信息接口补全真实昵称与 pin
  if (!nickname || nickname === '京东用户' || !authenticated) {
    try {
      const infoRes = await fetch('https://me-api.jd.com/user_new/info/GetJDUserInfoUnion', {
        signal: AbortSignal.timeout(7000),
        redirect: 'error',
        headers: {
          'User-Agent': JD_UA,
          Referer: 'https://home.jd.com/',
          Cookie: cookieHeader,
          Accept: 'application/json, text/plain, */*',
        },
      });
      const setCookies =
        typeof infoRes.headers.getSetCookie === 'function'
          ? infoRes.headers.getSetCookie()
          : [infoRes.headers.get('set-cookie') || ''].filter(Boolean);
      Object.assign(refreshedCookies, parseSetCookieHeaders(setCookies));

      if (infoRes.ok) {
        const infoJson = (await infoRes.json()) as {
          retcode?: string | number;
          data?: {
            userInfo?: {
              baseInfo?: {
                nickname?: string;
                curPin?: string;
                userLevel?: string | number;
              };
            };
          };
        };
        const baseInfo = infoJson?.data?.userInfo?.baseInfo;
        if (baseInfo?.curPin || baseInfo?.nickname) {
          authenticated = true;
          if (baseInfo.curPin && !pin) pin = baseInfo.curPin;
          if (baseInfo.nickname) nickname = baseInfo.nickname;
        }
      }
    } catch {
      // ignore fallback user info error
    }
  }

  return { authenticated, rejected: rejected && !authenticated, pin, nickname, refreshedCookies };
}

function isChromiumProfileLocked(error: unknown): boolean {
  return error instanceof Error &&
    /profile appears to be in use|failed to create a ProcessSingleton/i.test(error.message);
}

async function launchPersistentContext(profileDir: string): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });

  const isolatedHome = join(profileDir, '.home');
  const isolatedConfig = join(isolatedHome, '.config');
  const isolatedCache = join(isolatedHome, '.cache');
  mkdirSync(isolatedConfig, { recursive: true });
  mkdirSync(isolatedCache, { recursive: true });

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=OptimizationHints,OnDeviceModel,MediaRouter,Translate',
  ];
  const baseOptions = {
    headless: true,
    timeout: 15000,
    viewport: { width: 1280, height: 800 },
    args: launchArgs,
    env: {
      ...(process.env as Record<string, string>),
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedConfig,
      XDG_CACHE_HOME: isolatedCache,
    },

  };

  const candidateBins = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/lib/chromium/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((p): p is string => Boolean(p && existsSync(p)));

  let nativeError: unknown;
  for (const executablePath of new Set(candidateBins)) {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...baseOptions, executablePath });
    } catch (error) {
      if (isChromiumProfileLocked(error)) throw error;
      nativeError ??= error;
    }
  }

  try {
    return await chromium.launchPersistentContext(profileDir, { ...baseOptions, channel: 'chrome' });
  } catch (error) {
    if (isChromiumProfileLocked(error)) throw error;
    try {
      return await chromium.launchPersistentContext(profileDir, baseOptions);
    } catch (fallbackError) {
      if (isChromiumProfileLocked(fallbackError)) throw fallbackError;
      throw nativeError ?? fallbackError;
    }
  }
}

async function launchSharedBrowser(profileDir: string): Promise<BrowserContext> {
  try {
    return await launchPersistentContext(profileDir);
  } catch (error) {
    if (!isChromiumProfileLocked(error)) throw error;
  }

  // A replaced container can leave a lock owned by another hostname. Use an
  // isolated profile so an existing browser's lock and data are left intact.
  const temporaryProfile = mkdtempSync(join(tmpdir(), 'pricepulse-chromium-'));
  const cleanup = () => {
    try {
      rmSync(temporaryProfile, { recursive: true, force: true });
    } catch {
      // A cleanup error must not interrupt browser shutdown.
    }
  };
  try {
    const context = await launchPersistentContext(temporaryProfile);
    context.once('close', cleanup);
    return context;
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function restorePlatformCookies(context: BrowserContext, platform: Platform): Promise<void> {
  const saved = platform === 'jd' ? loadPersistedJdSession() : loadPersistedTaobaoSession();
  if (!saved || ('authExpiredAt' in saved && saved.authExpiredAt)) return;

  const current = await context.cookies();
  const cookieList = saved.cookieList?.length
    ? saved.cookieList.filter(cookie => accountDomains[platform].test(cookie.domain))
    : Object.entries(saved.cookies).map(([name, value]) => ({
        name, value, domain: platform === 'jd' ? '.jd.com' : '.taobao.com', path: '/',
        expires: -1, httpOnly: false, secure: true,
      }));
  const cookies = cookieList.filter(cookie =>
    cookie.value &&
    (!cookie.expires || cookie.expires === -1 || cookie.expires > Date.now() / 1000) &&
    !current.some(item =>
      item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path),
  );
  if (cookies.length) await context.addCookies(cookies);
}

export function ensureJdContextCookies(context: BrowserContext): Promise<void> {
  return restorePlatformCookies(context, 'jd');
}

export function ensureTaobaoContextCookies(context: BrowserContext): Promise<void> {
  return restorePlatformCookies(context, 'taobao');
}

let headlessIdleTimer: NodeJS.Timeout | undefined;
let headlessAuthClosing: Promise<void> | null = null;

function scheduleHeadlessIdleClose(context: BrowserContext) {
  if (headlessAuthContext !== context || headlessAuthClosing) return;
  clearTimeout(headlessIdleTimer);
  const hasOpenPage = () => context.pages().some(page => !page.isClosed() && page.url() !== 'about:blank');
  if (hasOpenPage()) return;

  headlessIdleTimer = setTimeout(() => {
    if (headlessAuthContext !== context || hasOpenPage()) return;
    headlessAuthClosing = context.close().catch(() => {}).finally(() => {
      headlessAuthClosing = null;
    });
  }, 15000);
  headlessIdleTimer.unref();
}

/**
 * 全局共享单例无头浏览器上下文（京东与淘宝共用同一个 Chromium 实例与不同 Tab，彻底避免多实例 Crashpad 锁死与内存翻倍）
 */
async function getSharedHeadlessContext(): Promise<BrowserContext> {
  if (headlessAuthClosing) await headlessAuthClosing;
  if (headlessAuthContext) {
    scheduleHeadlessIdleClose(headlessAuthContext);
    return headlessAuthContext;
  }
  if (headlessAuthLaunching) return headlessAuthLaunching;

  const task = (async () => {
    const profileDir = getSharedHeadlessProfilePath();
    const context = await launchSharedBrowser(profileDir);
    try {
      await ensureJdContextCookies(context);
      await ensureTaobaoContextCookies(context);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }

    headlessAuthContext = context;
    for (const page of context.pages()) page.once('close', () => scheduleHeadlessIdleClose(context));
    context.on('page', page => {
      clearTimeout(headlessIdleTimer);
      page.once('close', () => scheduleHeadlessIdleClose(context));
    });
    context.on('close', () => {
      if (headlessAuthContext === context) {
        clearTimeout(headlessIdleTimer);
        headlessAuthContext = null;
        headlessLoginPage = null;
        headlessTbPage = null;
      }
    });
    scheduleHeadlessIdleClose(context);
    return context;
  })();

  headlessAuthLaunching = task;
  try {
    return await task;
  } finally {
    headlessAuthLaunching = null;
  }
}

export async function getJdHeadlessContext(): Promise<BrowserContext> {
  return getSharedHeadlessContext();
}

async function getOrOpenHeadlessJdLoginPage(forceLoginUrl = false): Promise<Page> {
  const context = await getJdHeadlessContext();
  if (headlessLoginPage && !headlessLoginPage.isClosed()) {
    const currentUrl = headlessLoginPage.url();
    if (!forceLoginUrl && currentUrl && currentUrl !== 'about:blank') {
      return headlessLoginPage;
    }
    if (forceLoginUrl && currentUrl.includes('passport.jd.com/new/login.aspx')) {
      return headlessLoginPage;
    }
  } else {
    headlessLoginPage = await context.newPage();
  }

  await headlessLoginPage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await headlessLoginPage.goto(`${JD_LOGIN_PAGE_URL}?ReturnUrl=${encodeURIComponent('https://www.jd.com/')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 25000,
  });
  await headlessLoginPage.waitForTimeout(800);
  return headlessLoginPage;
}

async function syncCookiesFromHeadlessContext(
  extraCookies: Record<string, string> = {},
  source: 'qrcode' | 'sms' = 'qrcode',
  extraMeta?: { mobile?: string; lastCheckCode?: number; lastValidateReturnCode?: number },
): Promise<PersistedJdSession | null> {
  const version = authVersion.jd;
  const context = await getJdHeadlessContext();
  let browserCookies = (await context.cookies()).filter(cookie => accountDomains.jd.test(cookie.domain));

  const initialMap: Record<string, string> = { ...extraCookies };
  for (const c of browserCookies) {
    if (c.name && c.value && c.value !== 'deleted') {
      initialMap[c.name] = c.value;
    }
  }

  if (!hasJdAuth(initialMap)) return null;

  // 如果已经拿到了核心凭证 thor 或 pt_key，但还没有拿到主站 unick / pin 等完整 Cookie，让页面访问一次 www.jd.com 补齐主站 Cookie 与昵称
  let pageNickname = '';
  let pagePin = '';
  if (
    !initialMap.unick || !initialMap.pin
  ) {
    try {
      const page = headlessLoginPage;
      if (!page || page.isClosed()) return null;
      if (platformUrl(page.url(), 'jd')?.hostname !== 'www.jd.com') {
        await page.goto('https://www.jd.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000).catch(() => {});
      }
      const domUser = await page
        .evaluate(async () => {
          let nick = '';
          let uPin = '';
          try {
            const r = await fetch('https://passport.jd.com/user/petName/getUserInfoForMiniJd.action', {
              credentials: 'include',
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
              signal: AbortSignal.timeout(3500),
            });
            const j = (await r.json()) as { nickName?: string; pin?: string };
            nick = j?.nickName || '';
            uPin = j?.pin || '';
          } catch {
            // ignore
          }
          if (!nick) {
            const el = document.querySelector('.nickname, #ttbar-login .link-user, .user-name') as HTMLElement | null;
            if (el?.textContent && !/登录|注册/.test(el.textContent)) nick = el.textContent.trim();
          }
          return { nick, uPin };
        })
        .catch(() => ({ nick: '', uPin: '' }));
      pageNickname = domUser.nick;
      pagePin = domUser.uPin;
      browserCookies = (await context.cookies()).filter(cookie => accountDomains.jd.test(cookie.domain));
    } catch {
      // ignore
    }
  }

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
        sameSite: c.sameSite,
      });
    }
  }

  const header = buildCookieHeader(cookieMap);
  const verified = await verifyJdCookiesWithLoginService(header);
  if (!verified.authenticated || version !== authVersion.jd) return null;
  const verifiedAt = new Date().toISOString();
  Object.assign(cookieMap, verified.refreshedCookies);

  const pin =
    verified.pin ||
    pagePin ||
    decodeCookieValue(cookieMap.pin || cookieMap.pt_pin || cookieMap.pwdt_id || cookieMap.UseCorpPin) ||
    extraMeta?.mobile ||
    '';
  const nickname =
    (verified.nickname && verified.nickname !== verified.pin ? verified.nickname : '') ||
    pageNickname ||
    decodeCookieValue(cookieMap.unick) ||
    verified.nickname ||
    pin ||
    '京东用户';

  return savePersistedJdSession({
    pin,
    nickname,
    mobile: extraMeta?.mobile,
    cookies: cookieMap,
    cookieList,
    source,
    updatedAt: verifiedAt,
    lastKeepAliveAt: verifiedAt,
    lastVerifiedAt: verifiedAt,
    hadValidAuth: true,
    keepAliveCount: 0,
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

type JdSessionCheck = {
  state: 'logged_in' | 'login_required' | 'unverified';
  session: PersistedJdSession | null;
  message: string;
};

async function checkPersistedJdSession(): Promise<JdSessionCheck> {
  const session = loadPersistedJdSession();
  const version = authVersion.jd;
  if (!session || !hasJdAuth(session.cookies)) {
    return { state: 'login_required', session: null, message: '请完成京东登录与平台安全验证' };
  }
  if (session.authExpiredAt) {
    return { state: 'login_required', session: null, message: '京东已确认会话失效，请重新登录' };
  }

  const verified = await verifyJdCookiesWithLoginService(session.cookieHeader);
  if (version !== authVersion.jd || loadPersistedJdSession()?.updatedAt !== session.updatedAt) {
    return { state: 'unverified', session: null, message: '京东会话已变更，请刷新状态' };
  }
  if (verified.authenticated) {
    const now = new Date().toISOString();
    const updated = savePersistedJdSession({
      ...session,
      pin: verified.pin || session.pin,
      nickname: verified.nickname || session.nickname,
      cookies: { ...session.cookies, ...verified.refreshedCookies },
      hadValidAuth: true,
      lastVerifiedAt: now,
      lastKeepAliveAt: now,
      keepAliveCount: (session.keepAliveCount ?? 0) + 1,
    });
    return { state: 'logged_in', session: updated, message: `京东会话已验证（账号：${updated.nickname}）` };
  }
  if (!verified.rejected) {
    return { state: 'unverified', session, message: '暂时无法向京东确认登录状态，已保留会话，稍后可重试' };
  }

  const expiredAt = new Date().toISOString();
  const shouldNotify = Boolean(session.lastVerifiedAt && !session.expiredNotifiedAt);
  savePersistedJdSession({
    ...session,
    authExpiredAt: expiredAt,
    expiredNotifiedAt: shouldNotify ? expiredAt : session.expiredNotifiedAt,
  });
  if (shouldNotify) {
    void notifySessionExpiredToFeishu('jd', '京东已确认保存的会话失效，请重新登录').catch(() => {});
  }
  return { state: 'login_required', session: null, message: '京东已确认会话失效，请重新登录' };
}

function hasJdAuth(cookies: Record<string, string>): boolean {
  return Boolean(cookies.thor || (cookies.pt_key && cookies.pt_pin));
}

function hasTaobaoAuth(cookies: Record<string, string>): boolean {
  const auth = [cookies.cookie2, cookies.uc3, cookies.sgcookie].some(value => value && value !== 'deleted');
  const identity = [cookies.unb, cookies.tracknick, cookies._nk_].some(value => value && value !== 'deleted');
  return auth && identity;
}

export async function runJdSessionKeepAlive(): Promise<JdSessionCheck> {
  if (jdVerification) return jdVerification;
  jdVerification = checkPersistedJdSession();
  try {
    return await jdVerification;
  } finally {
    jdVerification = null;
  }
}

/**
 * 获取淘宝服务端常驻无头浏览器上下文（与京东共用全局单例 Chromium 上下文）
 */
export async function getTaobaoHeadlessContext(): Promise<BrowserContext> {
  return getSharedHeadlessContext();
}

async function syncTaobaoCookiesFromHeadlessContext(
  extraCookies: Record<string, string> = {},
  source: 'qrcode' | 'sms' = 'qrcode',
  mobile?: string,
): Promise<PersistedTaobaoSession | null> {
  const version = authVersion.taobao;
  const context = await getTaobaoHeadlessContext();
  const browserCookies = (await context.cookies()).filter(cookie => accountDomains.taobao.test(cookie.domain));
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
        sameSite: c.sameSite,
      });
    }
  }

  if (!hasTaobaoAuth(cookieMap) || version !== authVersion.taobao) return null;
  return savePersistedTaobaoSession({
    cookies: cookieMap,
    cookieList,
    source,
    mobile,
    updatedAt: new Date().toISOString(),
    lastKeepAliveAt: new Date().toISOString(),
  });
}

export async function runTaobaoSessionKeepAlive(): Promise<{
  ok: boolean;
  session: PersistedTaobaoSession | null;
  message: string;
}> {
  const session = loadPersistedTaobaoSession();
  if (!session) {
    return { ok: false, session: null, message: '尚未保存淘宝登录态' };
  }

  const mergedCookies = { ...session.cookies };
  try {
    const res = await fetch('https://www.taobao.com/', {
      headers: {
        'User-Agent': JD_UA,
        Cookie: buildCookieHeader(mergedCookies),
      },
    });
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') || ''].filter(Boolean);
    Object.assign(mergedCookies, parseSetCookieHeaders(setCookies));
  } catch {
    // ignore transient error
  }

  const updated = savePersistedTaobaoSession({
    ...session,
    cookies: mergedCookies,
    updatedAt: session.updatedAt,
    lastKeepAliveAt: new Date().toISOString(),
    keepAliveCount: (session.keepAliveCount ?? 0) + 1,
  });

  return {
    ok: true,
    session: updated,
    message: `淘宝服务端保活完成（账号：${updated.nick}，累计保活 ${updated.keepAliveCount} 次）`,
  };
}

async function open(platform: Platform): Promise<BrowserContext> {
  const active = contexts.get(platform);
  if (active) return active;
  const pending = launching.get(platform);
  if (pending) return pending;
  const operation = (async () => {
    const profile = join(getDataRoot(), 'PriceDrop', 'browser-profiles', platform);
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
    } catch {
      try {
        context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: false });
      } catch {
        context = await chromium.launchPersistentContext(profile, { headless: false });
      }
    }
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
export class SessionsController implements OnModuleInit, OnModuleDestroy {
  private readonly remoteBrowser = new RemoteBrowserControls<Platform>();
  onModuleInit() {
    if (!keepAliveTimer) {
      // 每 10 分钟在服务端后台执行一次京东与淘宝登录态保活心跳
      keepAliveTimer = setInterval(() => {
        void runJdSessionKeepAlive().catch(() => {});
        void runTaobaoSessionKeepAlive().catch(() => {});
      }, 10 * 60 * 1000);
      keepAliveTimer.unref?.();
    }
  }

  async onModuleDestroy() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    clearTimeout(headlessIdleTimer);
    if (headlessAuthClosing) await headlessAuthClosing;
    await this.remoteBrowser.clear();
    const openContexts = [...contexts.values()];
    if (headlessAuthContext) openContexts.push(headlessAuthContext);
    await Promise.allSettled(openContexts.map(context => context.close()));
  }

  private async getOrCreateRemotePage(
    platform: Platform,
    options?: { keepCurrent?: boolean },
  ): Promise<Page> {
    const context = await getSharedHeadlessContext();
    let page = platform === 'jd' ? headlessLoginPage : headlessTbPage;
    if (!page || page.isClosed()) {
      page = await context.newPage();
      if (platform === 'jd') headlessLoginPage = page;
      else headlessTbPage = page;
    }
    if (!options?.keepCurrent || !platformUrl(page.url(), platform)) {
      await page.goto(loginPages[platform], { waitUntil: 'domcontentloaded', timeout: 15000 })
        .catch(() => {});
    }
    return page;
  }

  private async closeCompletedLoginPage(platform: Platform, page: Page | null) {
    if (!page) return;
    // Keep the shared context and its cookies alive while releasing the login tab.
    await page.close().catch(() => {});
    if (platform === 'jd' && headlessLoginPage === page) headlessLoginPage = null;
    if (platform === 'taobao' && headlessTbPage === page) headlessTbPage = null;
  }

  private async captureRemoteFrameAndCheckAuth(
    platform: Platform,
    source: 'qrcode' | 'sms' = 'qrcode',
    mobile?: string,
  ) {
    const page = await this.getOrCreateRemotePage(platform, { keepCurrent: true });
    const url = platformUrl(page.url(), platform);
    const host = url?.hostname;
    const onJdChallenge = host === 'aq.jd.com' || host === 'safe.jd.com' || host === 'cfe.m.jd.com';
    const dragging = this.remoteBrowser.isDragging(platform, page);
    if (!dragging && platform === 'jd' && host && !onJdChallenge) {
      const saved = await syncCookiesFromHeadlessContext({}, source, { mobile });
      if (saved) {
        activeJdQrSession = null;
        await this.closeCompletedLoginPage('jd', page);
        return this.jdSessionResponse({
          state: 'logged_in', session: saved, message: `京东登录成功（账号：${saved.nickname}）`,
        });
      }
    }

    if (!dragging && platform === 'taobao' && host && !/^login\./.test(host) && host !== 'login.m.taobao.com') {
      const saved = await syncTaobaoCookiesFromHeadlessContext({}, source, mobile);
      if (saved) {
        activeTaobaoQrSession = null;
        await this.closeCompletedLoginPage('taobao', page);
        return {
          state: 'logged_in',
          code: 200,
          nickname: saved.nick,
          pin: saved.uid,
          source: saved.source,
          updatedAt: saved.updatedAt,
          lastKeepAliveAt: saved.lastKeepAliveAt,
          cookieCount: Object.keys(saved.cookies).length,
          storagePath: getTaobaoSessionFilePath(),
          message: `淘宝登录成功（账号：${saved.nick}）`,
        };
      }
    }

    const screenshot = url ? await this.remoteBrowser.screenshot(platform, page) : '';
    const title = url && !dragging ? await page.title().catch(() => '') : '';

    return {
      state: 'verify_required',
      url: url ? url.origin + url.pathname : '',
      title,
      screenshot,
      viewport: { width: 1280, height: 800 },
      message: screenshot
        ? '请在下方官方登录页面按平台提示操作，登录完成后会保存会话'
        : '暂时无法显示平台登录页，请重试或重置登录页面',
    };
  }

  /**
   * 0a. 启动或打开云端实时可视化浏览器交互画面（用于直接过人机验证、异地安全认证或可视化登录）
   */
  @Post(':platform/remote/start')
  async startRemoteBrowser(
    @Param('platform') input: string,
    @Body() body: { keepCurrent?: boolean; targetUrl?: never },
    @Req() req: Request,
  ) {
    validateOrigin(req);
    const platform = platformOf(input);
    if (body?.targetUrl !== undefined) throw new BadRequestException('只支持平台官方登录页');
    await this.getOrCreateRemotePage(platform, {
      keepCurrent: body?.keepCurrent ?? true,
    });
    return this.captureRemoteFrameAndCheckAuth(platform);
  }

  /**
   * 0b. 获取云端实时浏览器最新画面帧并自动检测是否已完成验证/登录
   */
  @Get(':platform/remote/frame')
  @Header('Cache-Control', 'no-store')
  async getRemoteBrowserFrame(@Param('platform') input: string, @Req() req: Request) {
    validateOrigin(req);
    const platform = platformOf(input);
    return this.captureRemoteFrameAndCheckAuth(platform);
  }

  private getPointerPage(platform: Platform): Page {
    const page = platform === 'jd' ? headlessLoginPage : headlessTbPage;
    if (!page || page.isClosed() || !platformUrl(page.url(), platform)) {
      throw new BadRequestException('平台登录页尚未就绪');
    }
    return page;
  }

  @Post(':platform/remote/pointer')
  async updateRemotePointer(
    @Param('platform') input: string,
    @Body() body: RemotePointerInput,
    @Req() req: Request,
  ) {
    validateOrigin(req);
    const platform = platformOf(input);
    return this.remoteBrowser.update(platform, () => this.getPointerPage(platform), body);
  }

  /**
   * 0c. 在云端实时浏览器画面上执行用户鼠标点击、滑块拖拽、键盘输入或滚动操作
   */
  @Post(':platform/remote/action')
  async performRemoteBrowserAction(
    @Param('platform') input: string,
    @Body()
    body: {
      type: 'click' | 'drag' | 'type' | 'key' | 'scroll' | 'reload';
      x?: number;
      y?: number;
      fromX?: number;
      fromY?: number;
      toX?: number;
      toY?: number;
      path?: Array<{ x: number; y: number }>;
      text?: string;
      key?: string;
      deltaX?: number;
      deltaY?: number;
    },
    @Req() req: Request,
  ) {
    validateOrigin(req);
    const platform = platformOf(input);
    if (!['click', 'drag', 'type', 'key', 'scroll', 'reload'].includes(body?.type)) {
      throw new BadRequestException('不支持的浏览器操作');
    }
    const page = await this.getOrCreateRemotePage(platform, { keepCurrent: true });
    if (!platformUrl(page.url(), platform)) throw new BadRequestException('平台登录页尚未就绪');
    if (this.remoteBrowser.isDragging(platform, page)) {
      throw new BadRequestException('请先松开鼠标再继续操作');
    }

    try {
      switch (body.type) {
        case 'click': {
          const x = Math.max(0, Math.min(1280, Math.round(Number(body.x) || 0)));
          const y = Math.max(0, Math.min(800, Math.round(Number(body.y) || 0)));
          await page.mouse.click(x, y, { delay: 35 });
          break;
        }
        case 'drag': {
          const points = Array.isArray(body.path) && body.path.length >= 2
            ? body.path.slice(0, 200)
            : [{ x: body.fromX, y: body.fromY }, { x: body.toX, y: body.toY }];
          const locations = points.map(point => ({
            x: Math.max(0, Math.min(1280, Number(point?.x) || 0)),
            y: Math.max(0, Math.min(800, Number(point?.y) || 0)),
          }));
          await page.mouse.move(locations[0].x, locations[0].y);
          await page.mouse.down();
          try {
            for (const point of locations.slice(1)) await page.mouse.move(point.x, point.y);
          } finally {
            await page.mouse.up();
          }
          break;
        }
        case 'type': {
          if (typeof body.text === 'string') {
            await page.keyboard.insertText(body.text.slice(0, 256));
          }
          break;
        }
        case 'key': {
          if (body.key && ['Backspace', 'Enter', 'Tab', 'Escape'].includes(body.key)) {
            await page.keyboard.press(String(body.key));
          }
          break;
        }
        case 'scroll': {
          await page.mouse.wheel(Number(body.deltaX) || 0, Number(body.deltaY) || 240);
          break;
        }
        case 'reload': {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 18000 }).catch(() => {});
          break;
        }

      }
    } catch {
      // ignore single interaction error and still return updated frame
    }

    await page.waitForTimeout(320).catch(() => {});
    return this.captureRemoteFrameAndCheckAuth(platform);
  }

  /**
   * 1. 获取京东网页扫码登录二维码
   * 在共享无头浏览器上下文中加载京东登录页并获取二维码，确保 QRCodeKey / wlfstk_smdl 与浏览器指纹 (eid/fp/3AB9D23F7A4B3C9B) 完全绑定
   */
  @Post('jd/qrcode/start')
  async startJdQrCode(@Req() req: Request) {
    validateOrigin(req);
    const now = Date.now();
    const showUrl = `${JD_QR_SHOW_URL}?appid=133&size=147&t=${now}`;

    let token = '';
    let qrCodeKey = '';
    let qrImage = '';
    const cookies: Record<string, string> = {};

    try {
      const context = await getJdHeadlessContext();
      const page = await getOrOpenHeadlessJdLoginPage(true);

      const inBrowserQr = await page.evaluate(async (u: string) => {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return `data:image/png;base64,${btoa(binary)}`;
      }, showUrl);

      if (inBrowserQr) {
        qrImage = inBrowserQr;
        const browserCookies = await context.cookies([
          'https://passport.jd.com',
          'https://qr.m.jd.com',
          'https://www.jd.com',
        ]);
        for (const c of browserCookies) {
          if (c.name && c.value) cookies[c.name] = c.value;
        }
        token = cookies.wlfstk_smdl || '';
        qrCodeKey = cookies.QRCodeKey || '';
      }
    } catch {
      // fallback to direct fetch below
    }

    if (!token || !qrCodeKey || !qrImage) {
      const res = await fetch(showUrl, {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
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
      Object.assign(cookies, parseSetCookieHeaders(rawSetCookies));
      token = cookies.wlfstk_smdl;
      qrCodeKey = cookies.QRCodeKey;

      if (!token || !qrCodeKey) {
        throw new InternalServerErrorException('京东二维码接口未返回有效的 wlfstk_smdl 或 QRCodeKey');
      }

      const imageBuffer = Buffer.from(await res.arrayBuffer());
      qrImage = `data:image/png;base64,${imageBuffer.toString('base64')}`;

      try {
        const context = await getJdHeadlessContext();
        await context.addCookies(
          Object.entries(cookies).flatMap(([name, value]) => [
            { name, value, domain: '.jd.com', path: '/' },
            { name, value, domain: 'qr.m.jd.com', path: '/' },
            { name, value, domain: 'passport.jd.com', path: '/' },
          ]),
        );
      } catch {
        // ignore
      }
    }

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
   * 当 code === 200 时，在服务端无头上下文内完成 h5st 签名与 Ticket 校验；
   * 若触发异地/新设备安全验证 (returnCode === 58 / aq.jd.com)，自动返回 verify_required 与实时浏览器验证画面，绝不伪造“京东用户 (12项Cookie)”假登录态
   */
  private pendingJdQrCheck: Promise<unknown> | null = null;

  @Get('jd/qrcode/status')
  @Header('Cache-Control', 'no-store')
  async checkJdQrStatus(@Req() req: Request) {
    validateOrigin(req);
    if (this.pendingJdQrCheck) return this.pendingJdQrCheck;
    this.pendingJdQrCheck = this.executeJdQrCheck();
    try {
      return await this.pendingJdQrCheck;
    } finally {
      this.pendingJdQrCheck = null;
    }
  }

  private async executeJdQrCheck() {
    const attempt = activeJdQrSession;
    if (!attempt) {
      return {
        state: 'qr_none',
        code: 0,
        message: '当前没有进行中的扫码会话',
      };
    }

    if (Date.now() > attempt.expiresAt) {
      return {
        state: 'qr_expired',
        code: 203,
        message: '二维码已超时失效，请点击刷新重新获取二维码',
      };
    }

    const callback = `jQuery${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;
    const checkUrl = `${JD_QR_CHECK_URL}?callback=${callback}&appid=133&token=${encodeURIComponent(
      attempt.token,
    )}&_=${Date.now()}`;

    const checkRes = await fetch(checkUrl, {
      signal: AbortSignal.timeout(7000),
      redirect: 'error',
      headers: {
        'User-Agent': JD_UA,
        Referer: JD_LOGIN_PAGE_URL,
        Cookie: buildCookieHeader(attempt.cookies),
      },
    });

    const rawText = await checkRes.text();
    const checkSetCookies =
      typeof checkRes.headers.getSetCookie === 'function'
        ? checkRes.headers.getSetCookie()
        : [checkRes.headers.get('set-cookie') || ''].filter(Boolean);
    if (activeJdQrSession !== attempt) return { state: 'qr_none', message: '扫码会话已变更' };
    Object.assign(attempt.cookies, parseSetCookieHeaders(checkSetCookies));

    const payload = parseJsonpPayload<{ code?: number; msg?: string; ticket?: string }>(rawText);
    if (!payload || typeof payload.code !== 'number') {
      return {
        state: 'qr_error',
        code: -1,
        message: '解析京东扫码状态响应失败',
      };
    }

    attempt.lastCode = payload.code;
    attempt.lastMessage = payload.msg || '';

    switch (payload.code) {
      case 201:
        return {
          state: 'qr_waiting',
          code: 201,
          message: payload.msg || '等待扫码（请打开手机京东 App 扫一扫）',
        };
      case 202:
        return {
          state: 'qr_scanned',
          code: 202,
          message: payload.msg || '扫描成功！请在手机京东 App 上点击「确认登录」',
        };
      case 203:
      case 204:
        return {
          state: 'qr_expired',
          code: payload.code,
          message: payload.msg || '二维码已失效，请点击刷新二维码',
        };
      case 205:
        return {
          state: 'qr_cancelled',
          code: 205,
          message: payload.msg || '已在手机端取消二维码登录',
        };
      case 200: {
        const ticket = payload.ticket;
        if (!ticket) {
          return {
            state: 'qr_error',
            code: 200,
                  message: '扫码已确认，但未获取到登录 ticket',
          };
        }

        attempt.ticket = ticket;
        const qrCookiesSnapshot = { ...attempt.cookies };
        let valJson: { returnCode?: number; url?: string } = {};

        try {
          const context = await getJdHeadlessContext();
          const page = await getOrOpenHeadlessJdLoginPage();
          const cookieItems = Object.entries(qrCookiesSnapshot).flatMap(([name, value]) => [
            { name, value, domain: '.jd.com', path: '/' },
            { name, value, domain: 'qr.m.jd.com', path: '/' },
            { name, value, domain: 'passport.jd.com', path: '/' },
          ]);
          await context.addCookies(cookieItems);

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
              signal: AbortSignal.timeout(10000),
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            return (await r.json()) as { returnCode?: number; url?: string };
          }, ticket);

          const targetUrl = valJson.url && platformUrl(valJson.url, 'jd');
          if (targetUrl) await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 16000 }).catch(() => {});
        } catch {
          // ignore headless ticket validation error, will run direct validation below
        }

        if (valJson.returnCode !== 0 && !valJson.url) {
          try {
            const validateUrl = `${JD_QR_VALIDATE_URL}?t=${encodeURIComponent(
              ticket,
            )}&pageSource=commonLogin&pageLocation=&ReturnUrl=${encodeURIComponent('https://www.jd.com/')}`;
            const valRes = await fetch(validateUrl, {
              signal: AbortSignal.timeout(10000),
              redirect: 'error',
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
            const parsedValCookies = parseSetCookieHeaders(valSetCookies);
            Object.assign(qrCookiesSnapshot, parsedValCookies);
            try {
              valJson = (await valRes.json()) as { returnCode?: number; url?: string };
            } catch {
              // ignore
            }
            const context = await getJdHeadlessContext();
            await context
              .addCookies(
                Object.entries(parsedValCookies).map(([name, value]) => ({
                  name,
                  value,
                  domain: '.jd.com',
                  path: '/',
                })),
              )
              .catch(() => {});

            const targetUrl = valJson.url && platformUrl(valJson.url, 'jd');
            if (targetUrl && headlessLoginPage && !headlessLoginPage.isClosed()) {
              await headlessLoginPage.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 16000 }).catch(() => {});
            }

          } catch {
            // ignore fallback network error
          }
        }

        // 检查是否真正拿到了核心登录凭证 thor / pt_key，若触发了 returnCode: 58 (aq.jd.com 安全魔方认证) 则弹出云端实时验证画面
        const context = await getJdHeadlessContext();
        const currentBrowserCookies = await context.cookies([
          'https://www.jd.com',
          'https://passport.jd.com',
          'https://m.jd.com',
        ]);
        const hasCoreAuth =
          Boolean(qrCookiesSnapshot.thor || qrCookiesSnapshot.pt_key) ||
          currentBrowserCookies.some(c => (c.name === 'thor' || c.name === 'pt_key') && c.value && c.value !== 'deleted');

        if (activeJdQrSession !== attempt) return { state: 'qr_none', message: '扫码会话已变更' };
        if (!hasCoreAuth || valJson.returnCode === 58) {
          activeJdQrSession = null;
          const frame = await this.captureRemoteFrameAndCheckAuth('jd', 'qrcode');
          if (frame.state === 'logged_in') {
            return frame;
          }
          return {
            ...frame,
            state: 'verify_required',
            code: valJson.returnCode,
            message: valJson.returnCode === 58
              ? '京东要求完成新设备安全验证，请在下方官方页面按提示操作'
              : '扫码已确认，京东尚未完成登录，请检查下方官方页面',
          };
        }

        const saved = await syncCookiesFromHeadlessContext(qrCookiesSnapshot, 'qrcode', {
          lastCheckCode: 200,
          lastValidateReturnCode: valJson.returnCode ?? 0,
        });

        if (activeJdQrSession !== attempt) return { state: 'qr_none', message: '扫码会话已变更' };
        activeJdQrSession = null;

        if (!saved) return this.captureRemoteFrameAndCheckAuth('jd');
        await this.closeCompletedLoginPage('jd', headlessLoginPage);

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
          message: `京东扫码登录成功（账号：${saved.nickname}，共 ${Object.keys(saved.cookies).length} 项 Cookie），登录态已长期保存在服务端`,
        };
      }
      default:
        return {
          state: 'qr_error',
          code: payload.code,
          message: payload.msg || `二维码状态异常 (code: ${payload.code})`,
        };
    }
  }

  /**
   * 3. 京东手机号验证码登录 — 发送短信验证码
   * 采用无头浏览器真实页面交互 + 响应拦截；若触发人机滑块/点选验证，自动返回 verify_required 与云端实时画面供用户在网页直接过验证
   */
  @Post('jd/sms/send')
  async sendJdSmsCode(@Body() body: { mobile?: string }, @Req() req: Request) {
    validateOrigin(req);
    const mobile = (body?.mobile || '').trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new BadRequestException('请输入有效的 11 位中国大陆手机号码');
    }

    activeJdQrSession = null;
    const page = await getOrOpenHeadlessJdLoginPage(true);

    // 切换到短信登录视图并填入手机号
    await page
      .evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('a, div, span, li'));
        const smsTab = (document.querySelector('#sms-login') as HTMLElement | null) || tabs.find(el => {
          const t = (el.textContent || '').trim();
          return t === '短信登录' || t === '手机验证码登录' || t === '验证码登录';
        }) as HTMLElement | undefined;
        if (smsTab) smsTab.click();
      })
      .catch(() => {});

    await page.waitForTimeout(300);

    let sendApiRes: { code?: number; msg?: string; rs?: number } | null = null;
    const waitSendPromise = page
      .waitForResponse(res => res.url().includes('/uc/mobile/sendMessage') || res.url().includes('sendMobileCode'), {
        timeout: 4500,
      })
      .then(async res => {
        const txt = await res.text();
        const cleaned = txt.trim().replace(/^[a-zA-Z0-9_$]+\(/, '').replace(/\);?$/, '');
        sendApiRes = JSON.parse(cleaned) as { code?: number; msg?: string; rs?: number };
      })
      .catch(() => {});

    const mobileSelector = '#mobile-number:visible, input[placeholder="请输入手机号"]:visible, input[name="mobile"]:visible';
    await page.locator(mobileSelector).first().fill(mobile, { timeout: 3000 }).catch(async () => {
      await page
        .evaluate((phone: string) => {
          const inp = document.querySelector('#mobile-number') as HTMLInputElement | null;
          if (inp) {
            inp.value = phone;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, mobile)
        .catch(() => {});
    });

    await page
      .evaluate(() => {
        const agree = document.querySelector(
          '#agreeCheck, .policy_tip-checkbox, input[type="checkbox"][name*="agree"]',
        ) as HTMLInputElement | null;
        if (agree && !agree.checked) agree.click();

        const sendBtn =
          (document.querySelector('#send-sms-code-btn, #sendMobileCode, .msg-btn, .get-code-btn') as HTMLElement | null) ||
          (Array.from(document.querySelectorAll('button, a, div, span')).find(
            el => (el.textContent || '').trim() === '获取验证码' && (el as HTMLElement).offsetWidth > 0,
          ) as HTMLElement | undefined);
        if (sendBtn) sendBtn.click();
      })
      .catch(() => {});

    await waitSendPromise;

    const apiResult = sendApiRes as { code?: number; msg?: string; rs?: number } | null;
    if (apiResult?.code === 1 || apiResult?.rs === 1) {
      return {
        ok: true,
        state: 'sms_sent',
        mobile,
        countdown: 60,
        raw: apiResult,
        message: apiResult.msg || `验证码已发送至 ${mobile}，请输入 6 位短信验证码`,
      };
    }

    // 若触发了人机验证弹窗（JDJRV 滑块/图形点选）或需在页面确认，自动返回实时浏览器画面让用户直接在网页完成验证
    const frame = await this.captureRemoteFrameAndCheckAuth('jd', 'sms', mobile);
    if (frame.state === 'logged_in') return frame;
    return {
      ...frame,
      ok: false,
      state: 'verify_required',
      mobile,
      message:
        apiResult?.msg ||
        '京东发送短信需完成人机安全验证，已为您自动打开下方云端实时画面（手机号已填入），请直接在画面中完成验证并获取验证码',
    };
  }

  /**
   * 4. 京东手机号验证码登录 — 提交验证码并完成登录态服务端持久化
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

    // 1. 先尝试在真实页面填入验证码并点击登录按钮
    await page
      .evaluate(
        ({ phone, smsCode }: { phone: string; smsCode: string }) => {
          const mInput = document.querySelector(
            '#mobile-number, input[placeholder*="手机号"]',
          ) as HTMLInputElement | null;
          if (mInput && !mInput.value) {
            mInput.value = phone;
            mInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const cInput = document.querySelector(
            '#sms-login-form #sms-code, #sms-login-form #mobile-code, #sms-login-form input[placeholder*="验证码"]',
          ) as HTMLInputElement | null;
          if (cInput) {
            cInput.value = smsCode;
            cInput.dispatchEvent(new Event('input', { bubbles: true }));
            cInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const agree = document.querySelector('#agreeCheck, .policy_tip-checkbox') as HTMLInputElement | null;
          if (agree && !agree.checked) agree.click();

          const loginBtn = document.querySelector(
            '#sms-login-submit',
          ) as HTMLElement | null;
          if (loginBtn) loginBtn.click();
        },
        { phone: mobile, smsCode: code },
      )
      .catch(() => {});

    await page.waitForTimeout(1200);

    const frameOrAuth = await this.captureRemoteFrameAndCheckAuth('jd', 'sms', mobile);
    if (frameOrAuth.state === 'logged_in') {
      return frameOrAuth;
    }

    return {
      ...frameOrAuth,
      state: 'verify_required',
      message: '京东短信登录需完成二次安全验证或人机校验，请在下方云端实时画面中直接完成验证',
    };
  }

  /**
   * 5. 查询当前服务端已保存的京东登录态详情（刷新网页时调用，绝不主动清空有效会话，也绝不重复乱发飞书告警）
   */
  private jdSessionResponse(result: JdSessionCheck) {
    const { state, session, message } = result;
    return {
      state,
      nickname: session?.nickname,
      pin: session?.pin,
      source: session?.source,
      updatedAt: session?.updatedAt,
      lastKeepAliveAt: session?.lastKeepAliveAt,
      keepAliveCount: session?.keepAliveCount ?? 0,
      cookieCount: session ? Object.keys(session.cookies).length : 0,
      storagePath: session ? getJdSessionFilePath() : undefined,
      message,
    };
  }

  @Get('jd/status')
  async getJdStatus() {
    return this.jdSessionResponse(await runJdSessionKeepAlive());
  }

  @Post('jd/keepalive')
  async manualKeepAlive(@Req() req: Request) {
    validateOrigin(req);
    return this.getJdStatus();
  }

  /**
   * 6b. 退出京东账号并清除服务端持久化 Cookie
   */
  @Post('jd/logout')
  async logoutJd(@Req() req: Request) {
    validateOrigin(req);
    authVersion.jd++;
    const filePath = getJdSessionFilePath();
    if (existsSync(filePath)) unlinkSync(filePath);
    activeJdQrSession = null;
    const page = headlessLoginPage;
    headlessLoginPage = null;
    await page?.close().catch(() => {});
    await headlessAuthContext?.clearCookies({ domain: accountDomains.jd });
    return {
      state: 'login_required',
      nickname: '未登录',
      pin: '—',
      cookieCount: 0,
      message: '已退出京东账号，服务端持久化登录态已清除',
    };
  }

  private pendingTaobaoQrStart: Promise<unknown> | null = null;

  /**
   * 7. 获取淘宝网页内扫码登录二维码
   */
  @Post('taobao/qrcode/start')
  async startTaobaoQrCode(@Req() req: Request) {
    validateOrigin(req);
    if (this.pendingTaobaoQrStart) {
      return this.pendingTaobaoQrStart;
    }
    const task = this.executeStartTaobaoQrCode();
    this.pendingTaobaoQrStart = task;
    try {
      return await task;
    } finally {
      this.pendingTaobaoQrStart = null;
    }
  }

  private async executeStartTaobaoQrCode() {
    const attempt: ActiveTaobaoQrSession = {
      expiresAt: Date.now() + 120_000,
      lastStatus: 'NEW',
    };
    activeTaobaoQrSession = attempt;
    const page = await this.getOrCreateRemotePage('taobao', { keepCurrent: false });
    const qrSelector = '.qrcode-img canvas, .qrcode-img img, #qrcode-img canvas, #qrcode-img img';
    const onResponse = async (res: { url: () => string; json: () => Promise<unknown> }) => {
      const url = platformUrl(res.url(), 'taobao');
      if (!url?.pathname.endsWith('/qrCode/query.do') || activeTaobaoQrSession !== attempt) return;
      const json = await res.json().catch(() => null) as {
        content?: { data?: { qrCodeStatus?: ActiveTaobaoQrSession['lastStatus'] } };
      } | null;
      if (json?.content?.data?.qrCodeStatus) attempt.lastStatus = json.content.data.qrCodeStatus;
    };
    page.on('response', onResponse);
    const removeObserver = () => page.off('response', onResponse);
    const timeout = setTimeout(removeObserver, 120_000);
    timeout.unref();

    try {
      const switchAccount = page.getByText(/^(使用其他账号登录|其他账号登录)$/).filter({ visible: true }).first();
      if (await switchAccount.isVisible()) await switchAccount.click({ timeout: 2500 });
      const readyQr = await page.waitForFunction((selector): Element | null => {
        for (const element of document.querySelectorAll(selector)) {
          const rect = element.getBoundingClientRect();
          if (rect.width < 90 || rect.height < 90 || getComputedStyle(element).visibility !== 'visible') continue;
          if (element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0) {
            return element;
          }
          if (!(element instanceof HTMLCanvasElement) || !element.width || !element.height) continue;
          try {
            const pixels = element.getContext('2d')
              ?.getImageData(0, 0, element.width, element.height).data;
            if (pixels?.some((value, index) => index % 4 === 3 && value > 0 && pixels[index - 3] < 96)) {
              return element;
            }
          } catch {
            // A canvas with cross-origin content can still be captured as an element.
            return element;
          }
        }
        return null;
      }, qrSelector, { timeout: 20000, polling: 250 });
      let qrImage: string;
      try {
        const qr = readyQr.asElement();
        if (!qr) throw new Error('淘宝二维码尚未绘制');
        const image = await qr.evaluate(element => {
          try {
            return element instanceof HTMLCanvasElement ? element.toDataURL('image/png') : '';
          } catch {
            return '';
          }
        });
        qrImage = image || `data:image/png;base64,${(await qr.screenshot({ type: 'png', timeout: 8000 })).toString('base64')}`;
      } finally {
        await readyQr.dispose();
      }
      if (activeTaobaoQrSession !== attempt) throw new Error('二维码已更新');
      return {
        state: 'qr_ready',
        qrImage,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
        message: '请打开手机淘宝 App 扫描下方二维码登录',
      };
    } catch {
      removeObserver();
      activeTaobaoQrSession = null;
      const frame = await this.captureRemoteFrameAndCheckAuth('taobao');
      return frame.state === 'logged_in' ? frame : {
        ...frame,
        message: '淘宝登录页未显示二维码，请在实时画面中选择扫码登录或按平台提示操作',
      };
    }
  }

  @Get('taobao/qrcode/status')
  @Header('Cache-Control', 'no-store')
  async checkTaobaoQrStatus(@Req() req: Request) {
    validateOrigin(req);
    const attempt = activeTaobaoQrSession;
    if (!attempt) return { state: 'qr_none', code: 0, message: '当前没有进行中的淘宝扫码会话' };
    if (Date.now() > attempt.expiresAt || attempt.lastStatus === 'EXPIRED') {
      return { state: 'qr_expired', code: 103, message: '淘宝二维码已失效，请重新获取二维码' };
    }
    if (attempt.lastStatus === 'CANCELED' || attempt.lastStatus === 'ERROR') {
      return { state: 'qr_cancelled', code: 105, message: '淘宝扫码已取消，请重新获取二维码' };
    }
    const url = headlessTbPage && platformUrl(headlessTbPage.url(), 'taobao');
    if (attempt.lastStatus === 'CONFIRMED' || (url && !/^login\./.test(url.hostname))) {
      activeTaobaoQrSession = null;
      return this.captureRemoteFrameAndCheckAuth('taobao');
    }
    if (attempt.lastStatus === 'SCANED') {
      return { state: 'qr_scanned', code: 101, message: '请在手机淘宝 App 确认登录' };
    }
    return { state: 'qr_waiting', code: 100, message: '请打开手机淘宝 App 扫码登录' };
  }

  /**
   * 7c. 淘宝手机号短信验证码登录 — 发送验证码
   * 若触发滑块安全验证 (baxia-dialog / nc_wrapper)，自动返回 verify_required 与云端实时画面供用户直接拖动滑块
   */
  @Post('taobao/sms/send')
  async sendTaobaoSmsCode(@Body() body: { mobile?: string }, @Req() req: Request) {
    validateOrigin(req);
    const mobile = (body?.mobile || '').trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new BadRequestException('请输入有效的 11 位中国大陆手机号码');
    }

    activeTaobaoQrSession = null;
    const page = await this.getOrCreateRemotePage('taobao', { keepCurrent: true });
    if (!page.url().includes('login.taobao.com')) {
      await page.goto(TB_LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    // 切换到短信验证码登录 Tab
    await page
      .evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a, div, span, li'));
        const otherLink = candidates.find(el => {
          const t = (el.textContent || '').trim();
          return t === '使用其他账号登录' || t === '其他账号登录';
        }) as HTMLElement | undefined;
        if (otherLink) otherLink.click();

        const smsTab =
          (document.querySelector('.sms-login-tab-item') as HTMLElement | null) ||
          (candidates.find(el => (el.textContent || '').trim() === '短信登录') as HTMLElement | undefined);
        if (smsTab) smsTab.click();
      })
      .catch(() => {});

    await page.waitForTimeout(450);

    let sendApiRes: { content?: { data?: { resultCode?: number; titleMsg?: string }; success?: boolean } } | null =
      null;
    const responsePromise = page
      .waitForResponse(res => res.url().includes('sms/sendSms.do'), { timeout: 4500 })
      .then(async res => {
        sendApiRes = (await res.json()) as {
          content?: { data?: { resultCode?: number; titleMsg?: string }; success?: boolean };
        };
      })
      .catch(() => {});

    await page.locator('#fm-sms-login-id:visible').fill(mobile, { timeout: 3500 }).catch(() => {});
    await page
      .evaluate(() => {
        const agree = document.querySelector('#fm-agreement-checkbox') as HTMLInputElement | null;
        if (agree && !agree.checked) agree.click();
        const sendBtn =
          (document.querySelector('.send-btn-link') as HTMLElement | null) ||
          (Array.from(document.querySelectorAll('a, button, span')).find(
            el => (el.textContent || '').trim() === '获取验证码',
          ) as HTMLElement | undefined);
        if (sendBtn) sendBtn.click();
      })
      .catch(() => {});

    await responsePromise;

    const sendRes = sendApiRes as {
      content?: { data?: { resultCode?: number; titleMsg?: string }; success?: boolean };
    } | null;
    const resultCode = sendRes?.content?.data?.resultCode;
    if (resultCode === 100) {
      return {
        ok: true,
        state: 'sms_sent',
        mobile,
        countdown: 60,
        raw: sendRes,
        message: `淘宝短信验证码已发送至 ${mobile}，请输入收到的验证码`,
      };
    }

    const frame = await this.captureRemoteFrameAndCheckAuth('taobao', 'sms', mobile);
    if (frame.state === 'logged_in') return frame;
    return {
      ...frame,
      ok: false,
      state: 'verify_required',
      mobile,
      message:
        sendRes?.content?.data?.titleMsg ||
        '淘宝发送短信触发滑块安全验证，已为您自动打开下方云端实时画面（手机号已填入），请直接在画面中拖动滑块完成验证',
    };
  }

  /**
   * 7d. 淘宝手机号短信验证码登录 — 提交验证码并持久化 Cookie
   */
  @Post('taobao/sms/login')
  async loginTaobaoWithSms(@Body() body: { mobile?: string; code?: string }, @Req() req: Request) {
    validateOrigin(req);
    const mobile = (body?.mobile || '').trim();
    const code = (body?.code || '').trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new BadRequestException('请输入有效的 11 位手机号码');
    }
    if (!/^\d{4,6}$/.test(code)) {
      throw new BadRequestException('请输入有效的短信验证码');
    }

    const page = await this.getOrCreateRemotePage('taobao', { keepCurrent: true });

    let loginApiRes: {
      content?: {
        data?: { resultCode?: number; titleMsg?: string; redirectUrl?: string; iframeRedirectUrl?: string };
        success?: boolean;
      };
    } | null = null;

    const responsePromise = page
      .waitForResponse(res => res.url().includes('sms/login.do'), { timeout: 6000 })
      .then(async res => {
        loginApiRes = (await res.json()) as {
          content?: {
            data?: { resultCode?: number; titleMsg?: string; redirectUrl?: string; iframeRedirectUrl?: string };
            success?: boolean;
          };
        };
      })
      .catch(() => {});

    await page.locator('#fm-sms-login-id:visible').fill(mobile, { timeout: 3500 }).catch(() => {});
    await page.locator('#fm-smscode:visible').fill(code, { timeout: 3500 }).catch(() => {});
    await page
      .evaluate(() => {
        const agree = document.querySelector('#fm-agreement-checkbox') as HTMLInputElement | null;
        if (agree && !agree.checked) agree.click();
        const submitBtn = document.querySelector('button.sms-login') as HTMLElement | null;
        if (submitBtn) submitBtn.click();
      })
      .catch(() => {});

    await responsePromise;

    const loginRes = loginApiRes as {
      content?: {
        data?: { resultCode?: number; titleMsg?: string; redirectUrl?: string; iframeRedirectUrl?: string };
        success?: boolean;
      };
    } | null;
    const resData = loginRes?.content?.data;
    const targetUrl = resData?.redirectUrl || resData?.iframeRedirectUrl;
    if (targetUrl) {
      const url = platformUrl(targetUrl, 'taobao');
      if (url) await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000).catch(() => {});
    }

    const frameOrAuth = await this.captureRemoteFrameAndCheckAuth('taobao', 'sms', mobile);
    if (frameOrAuth.state === 'logged_in') {
      return frameOrAuth;
    }

    return {
      ...frameOrAuth,
      state: 'verify_required',
      message: resData?.titleMsg || '淘宝登录需完成二次验证或滑块确认，请在下方云端实时画面中完成操作',
    };
  }

  /**
   * 7e. 查询服务端已保存的淘宝 / 天猫登录态详情
   */
  @Get('taobao/status')
  async getTaobaoStatus() {
    const saved = loadPersistedTaobaoSession();
    const hasCoreAuthCookie = saved && hasTaobaoAuth(saved.cookies);
    if (saved && hasCoreAuthCookie && Object.keys(saved.cookies).length > 0) {
      return {
        state: 'logged_in',
        nickname: saved.nick,
        pin: saved.uid || saved.nick,
        mobile: saved.mobile,
        source: saved.source || 'qrcode',
        updatedAt: saved.updatedAt,
        lastKeepAliveAt: saved.lastKeepAliveAt || saved.updatedAt,
        keepAliveCount: saved.keepAliveCount ?? 0,
        cookieCount: Object.keys(saved.cookies).length,
        storagePath: getTaobaoSessionFilePath(),
        message: `淘宝登录态已长期保存在服务端（账号：${saved.nick}，共 ${Object.keys(saved.cookies).length} 项 Cookie）`,
      };
    }
    return {
      state: 'login_required',
      nickname: '未登录',
      pin: '—',
      cookieCount: 0,
      message: saved
        ? '淘宝核心登录凭证 (cookie2/uc3) 缺失或已过期，请使用下方「淘宝 App 扫码登录」重新扫码同步'
        : '尚未保存淘宝 / 天猫登录态，请使用下方「淘宝 App 扫码登录」或「手机号短信验证码登录」',
    };
  }

  /**
   * 8. 手动触发淘宝服务端登录态保活刷新
   */
  @Post('taobao/keepalive')
  async keepAliveTaobao(@Req() req: Request) {
    validateOrigin(req);
    const res = await runTaobaoSessionKeepAlive();
    if (!res.ok || !res.session) {
      throw new BadRequestException(res.message);
    }
    return {
      state: 'logged_in',
      nickname: res.session.nick,
      pin: res.session.uid || res.session.nick,
      source: res.session.source,
      updatedAt: res.session.updatedAt,
      lastKeepAliveAt: res.session.lastKeepAliveAt,
      keepAliveCount: res.session.keepAliveCount,
      cookieCount: Object.keys(res.session.cookies).length,
      storagePath: getTaobaoSessionFilePath(),
      message: res.message,
    };
  }

  /**
   * 8b. 退出淘宝账号并清除服务端持久化 Cookie
   */
  @Post('taobao/logout')
  async logoutTaobao(@Req() req: Request) {
    validateOrigin(req);
    authVersion.taobao++;
    const filePath = getTaobaoSessionFilePath();
    if (existsSync(filePath)) unlinkSync(filePath);
    activeTaobaoQrSession = null;
    const page = headlessTbPage;
    headlessTbPage = null;
    await page?.close().catch(() => {});
    await headlessAuthContext?.clearCookies({ domain: accountDomains.taobao });
    return {
      state: 'login_required',
      nickname: '未登录',
      pin: '—',
      cookieCount: 0,
      message: '已退出淘宝账号，服务端持久化登录态已清除',
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
      return {
        state: 'opened',
        message:
          platform === 'taobao'
            ? '淘宝登录窗口已打开，扫码登录成功后请点击「同步并检查淘宝状态」保存至服务端'
            : '浏览器已打开，请在窗口中自行登录',
      };
    } catch {
      throw new InternalServerErrorException('无法打开项目浏览器，请确认本地 Chrome 或 Edge 未被占用');
    }
  }

  @Post(':platform/check')
  async check(@Param('platform') input: string, @Req() req: Request) {
    validateOrigin(req);
    const platform = platformOf(input);

    if (platform === 'jd') {
      const frameCheck = await this.captureRemoteFrameAndCheckAuth('jd');
      if (frameCheck.state === 'logged_in') {
        return frameCheck;
      }
      const jdStatus = await this.getJdStatus();
      if (jdStatus.state === 'logged_in') {
        return jdStatus;
      }
      return jdStatus;
    }

    if (platform === 'taobao') {
      const frameCheck = await this.captureRemoteFrameAndCheckAuth('taobao');
      if (frameCheck.state === 'logged_in') {
        return frameCheck;
      }
      const tbStatus = await this.getTaobaoStatus();
      if (tbStatus.state === 'logged_in') {
        return tbStatus;
      }
      return tbStatus;
    }

    return {
      state: 'unknown',
      message: '不支持的平台',
    };
  }
}
