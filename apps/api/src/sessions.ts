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
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  hadValidAuth?: boolean;
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
  t: number;
  ck: string;
  codeContent: string;
  csrf: string;
  qrImage: string;
  createdAt: number;
  expiresAt: number;
  lastStatus: 'NEW' | 'SCANED' | 'CONFIRMED' | 'EXPIRED' | 'CANCELED' | 'ERROR';
  lastMessage: string;
  redirectUrl?: string;
}

const JD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JD_LOGIN_PAGE_URL = 'https://passport.jd.com/new/login.aspx';
const JD_QR_SHOW_URL = 'https://qr.m.jd.com/show';
const JD_QR_CHECK_URL = 'https://qr.m.jd.com/check';
const JD_QR_VALIDATE_URL = 'https://passport.jd.com/uc/qrCodeTicketValidation';
const JD_LOGIN_VERIFY_URL = 'https://passport.jd.com/loginservice.aspx';

const TB_LOGIN_PAGE_URL = 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&sub=true';
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
let headlessTbContext: BrowserContext | null = null;
let headlessTbLaunching: Promise<BrowserContext> | null = null;
let headlessTbPage: Page | null = null;

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
  const mergedCookies: Record<string, string> = {
    ...(existing?.cookies || {}),
    ...incoming.cookies,
  };
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
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  return session;
}

function getSharedHeadlessProfilePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'browser-profiles', 'shared-headless');
}

function getTaobaoHeadlessProfilePath(): string {
  return join(getDataRoot(), 'PriceDrop', 'browser-profiles', 'taobao-headless');
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
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
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

  const hasCoreAuth = Boolean(mergedCookies.thor || mergedCookies.pt_key);
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
    decodeCookieValue(mergedCookies.unick || mergedCookies. TrackID) ||
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
    hadValidAuth: hasCoreAuth ? true : (incoming.hadValidAuth ?? existing?.hadValidAuth ?? false),
    expiredNotifiedAt: hasCoreAuth ? undefined : (incoming.expiredNotifiedAt ?? existing?.expiredNotifiedAt),
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
  let authenticated = false;
  let pin = '';
  let nickname = '';

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

  return { authenticated, pin, nickname, refreshedCookies };
}

function cleanStaleChromiumLocks(dir: string) {
  for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      rmSync(join(dir, lockName), { force: true });
    } catch {
      // ignore
    }
  }
}

async function launchStealthPersistentContext(profileDir: string): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  cleanStaleChromiumLocks(profileDir);
  cleanStaleChromiumLocks(getJdHeadlessProfilePath());
  cleanStaleChromiumLocks(getTaobaoHeadlessProfilePath());

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
    '--disable-blink-features=AutomationControlled',
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
    userAgent: JD_UA,
    viewport: { width: 1280, height: 800 },
    args: launchArgs,
    env: {
      ...(process.env as Record<string, string>),
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedConfig,
      XDG_CACHE_HOME: isolatedCache,
    },
    extraHTTPHeaders: {
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  };

  let context: BrowserContext | null = null;
  const candidateBins = [
    '/usr/lib/chromium/chromium',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((p): p is string => Boolean(p && existsSync(p)));

  for (const executablePath of candidateBins) {
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        ...baseOptions,
        executablePath,
      });
      break;
    } catch {
      cleanStaleChromiumLocks(profileDir);
    }
  }

  if (!context) {
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        ...baseOptions,
        channel: 'chrome',
      });
    } catch {
      context = await chromium.launchPersistentContext(profileDir, baseOptions);
    }
  }

  await context
    .addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    })
    .catch(() => {});

  return context;
}

export async function ensureJdContextCookies(context: BrowserContext): Promise<void> {
  const existing = loadPersistedJdSession();
  if (!existing) return;
  try {
    const entries = Object.entries(existing.cookies).filter(([k, v]) => Boolean(k && v));
    const toAdd = entries.flatMap(([name, value]) => [
      { name, value: String(value), domain: '.jd.com', path: '/' },
      { name, value: String(value), domain: 'item.jd.com', path: '/' },
      { name, value: String(value), domain: 'passport.jd.com', path: '/' },
    ]);
    if (toAdd.length > 0) {
      await context.addCookies(toAdd);
    }
  } catch {
    // ignore cookie injection warnings
  }
}

export async function ensureTaobaoContextCookies(context: BrowserContext): Promise<void> {
  const existing = loadPersistedTaobaoSession();
  if (!existing) return;
  try {
    const entries = Object.entries(existing.cookies).filter(([k, v]) => Boolean(k && v));
    const toAdd = entries.flatMap(([name, value]) => [
      { name, value: String(value), domain: '.taobao.com', path: '/' },
      { name, value: String(value), domain: '.tmall.com', path: '/' },
    ]);
    if (existing.cookieList && existing.cookieList.length > 0) {
      for (const c of existing.cookieList) {
        if (c.name && c.value) {
          toAdd.push({
            name: c.name,
            value: String(c.value),
            domain: c.domain || '.taobao.com',
            path: c.path || '/',
          });
        }
      }
    }
    if (toAdd.length > 0) {
      await context.addCookies(toAdd);
    }
  } catch {
    // ignore cookie injection warnings
  }
}

/**
 * 全局共享单例无头浏览器上下文（京东与淘宝共用同一个 Chromium 实例与不同 Tab，彻底避免多实例 Crashpad 锁死与内存翻倍）
 */
async function getSharedHeadlessContext(): Promise<BrowserContext> {
  if (headlessAuthContext) {
    return headlessAuthContext;
  }
  if (headlessAuthLaunching) return headlessAuthLaunching;

  const task = (async () => {
    const profileDir = getSharedHeadlessProfilePath();
    const context = await launchStealthPersistentContext(profileDir);
    await ensureJdContextCookies(context);
    await ensureTaobaoContextCookies(context);

    headlessAuthContext = context;
    headlessTbContext = context;
    context.on('close', () => {
      if (headlessAuthContext === context) {
        headlessAuthContext = null;
        headlessTbContext = null;
        headlessLoginPage = null;
        headlessTbPage = null;
      }
    });
    return context;
  })();

  headlessAuthLaunching = task;
  headlessTbLaunching = task;
  try {
    return await task;
  } finally {
    headlessAuthLaunching = null;
    headlessTbLaunching = null;
  }
}

export async function getJdHeadlessContext(): Promise<BrowserContext> {
  const ctx = await getSharedHeadlessContext();
  await ensureJdContextCookies(ctx);
  return ctx;
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
): Promise<PersistedJdSession> {
  const context = await getJdHeadlessContext();
  let browserCookies = await context.cookies([
    'https://www.jd.com',
    'https://passport.jd.com',
    'https://item.jd.com',
    'https://m.jd.com',
    'https://item.m.jd.com',
    'https://home.jd.com',
    'https://aq.jd.com',
  ]);

  const initialMap: Record<string, string> = { ...extraCookies };
  for (const c of browserCookies) {
    if (c.name && c.value && c.value !== 'deleted') {
      initialMap[c.name] = c.value;
    }
  }

  // 如果已经拿到了核心凭证 thor 或 pt_key，但还没有拿到主站 unick / pin 等完整 Cookie，让页面访问一次 www.jd.com 补齐主站 Cookie 与昵称
  let pageNickname = '';
  let pagePin = '';
  if (
    (initialMap.thor || initialMap.pt_key) &&
    (!initialMap.unick || !initialMap.pin || Object.keys(initialMap).length < 18)
  ) {
    try {
      const page = headlessLoginPage && !headlessLoginPage.isClosed() ? headlessLoginPage : await context.newPage();
      if (!page.url().includes('www.jd.com')) {
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
            });
            const j = (await r.json()) as { nickName?: string; realName?: string; pin?: string };
            nick = j?.nickName || j?.realName || '';
            uPin = j?.pin || '';
          } catch {
            // ignore
          }
          if (!nick) {
            const el = document.querySelector('.nickname, #ttbar-login .link-user, .user-name') as HTMLElement | null;
            if (el?.textContent) nick = el.textContent.trim();
          }
          return { nick, uPin };
        })
        .catch(() => ({ nick: '', uPin: '' }));
      pageNickname = domUser.nick;
      pagePin = domUser.uPin;
      browserCookies = await context.cookies([
        'https://www.jd.com',
        'https://passport.jd.com',
        'https://item.jd.com',
        'https://m.jd.com',
        'https://item.m.jd.com',
        'https://home.jd.com',
        'https://aq.jd.com',
      ]);
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
      });
    }
  }

  const header = buildCookieHeader(cookieMap);
  const verified = await verifyJdCookiesWithLoginService(header);
  Object.assign(cookieMap, verified.refreshedCookies);

  const pin =
    verified.pin ||
    pagePin ||
    decodeCookieValue(cookieMap.pin || cookieMap.pt_pin || cookieMap.pwdt_id || cookieMap.UseCorpPin) ||
    extraMeta?.mobile ||
    '';
  const nickname =
    verified.nickname ||
    pageNickname ||
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

  // 保活时绝不删除已有的核心登录 Cookie (thor / pt_key / pin / unick)
  if (session.cookies.thor && !mergedCookies.thor) mergedCookies.thor = session.cookies.thor;
  if (session.cookies.pt_key && !mergedCookies.pt_key) mergedCookies.pt_key = session.cookies.pt_key;
  if (session.cookies.pin && !mergedCookies.pin) mergedCookies.pin = session.cookies.pin;
  if (session.cookies.unick && !mergedCookies.unick) mergedCookies.unick = session.cookies.unick;

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

/**
 * 获取淘宝服务端常驻无头浏览器上下文（与京东共用全局单例 Chromium 上下文）
 */
export async function getTaobaoHeadlessContext(): Promise<BrowserContext> {
  const ctx = await getSharedHeadlessContext();
  await ensureTaobaoContextCookies(ctx);
  return ctx;
}

async function syncTaobaoCookiesFromHeadlessContext(
  extraCookies: Record<string, string> = {},
  source: 'qrcode' | 'sms' = 'qrcode',
  mobile?: string,
): Promise<PersistedTaobaoSession> {
  const context = await getTaobaoHeadlessContext();
  const browserCookies = await context.cookies([
    'https://www.taobao.com',
    'https://www.tmall.com',
    'https://detail.tmall.com',
    'https://item.taobao.com',
    'https://login.taobao.com',
    'https://i.taobao.com',
    'https://h5api.m.taobao.com',
    'https://h5api.m.tmall.com',
  ]);
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
export class SessionsController implements OnModuleInit {
  onModuleInit() {
    if (!keepAliveTimer) {
      // 每 10 分钟在服务端后台执行一次京东与淘宝登录态保活心跳
      keepAliveTimer = setInterval(() => {
        void runJdSessionKeepAlive();
        void runTaobaoSessionKeepAlive();
      }, 10 * 60 * 1000);
      keepAliveTimer.unref?.();
    }
  }

  private async getOrCreateRemotePage(
    platform: Platform,
    options?: { targetUrl?: string; keepCurrent?: boolean },
  ): Promise<Page> {
    if (platform === 'jd') {
      const context = await getJdHeadlessContext();
      if (!headlessLoginPage || headlessLoginPage.isClosed()) {
        headlessLoginPage = await context.newPage();
        await headlessLoginPage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
      }
      const curUrl = headlessLoginPage.url();
      const target = options?.targetUrl || `${JD_LOGIN_PAGE_URL}?ReturnUrl=${encodeURIComponent('https://www.jd.com/')}`;
      if (options?.targetUrl || curUrl === 'about:blank' || (!options?.keepCurrent && !curUrl.includes('jd.com'))) {
        await headlessLoginPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 22000 }).catch(() => {});
        await headlessLoginPage.waitForTimeout(500).catch(() => {});
      }
      return headlessLoginPage;
    }

    const context = await getTaobaoHeadlessContext();
    if (!headlessTbPage || headlessTbPage.isClosed()) {
      headlessTbPage = await context.newPage();
      await headlessTbPage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
    }
    const curUrl = headlessTbPage.url();
    const target = options?.targetUrl || TB_LOGIN_PAGE_URL;
    if (
      options?.targetUrl ||
      curUrl === 'about:blank' ||
      (!options?.keepCurrent && !curUrl.includes('taobao.com') && !curUrl.includes('tmall.com'))
    ) {
      await headlessTbPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 22000 }).catch(() => {});
      await headlessTbPage.waitForTimeout(500).catch(() => {});
    }
    return headlessTbPage;
  }

  private async captureRemoteFrameAndCheckAuth(
    platform: Platform,
    source: 'qrcode' | 'sms' = 'qrcode',
    mobile?: string,
  ) {
    const page = await this.getOrCreateRemotePage(platform, { keepCurrent: true });
    const context = await getSharedHeadlessContext();
    const curUrl = page.url();

    if (platform === 'jd') {
      const jdCookies = await context.cookies([
        'https://www.jd.com',
        'https://passport.jd.com',
        'https://m.jd.com',
        'https://home.jd.com',
      ]);
      const hasCore = jdCookies.some(c => (c.name === 'thor' || c.name === 'pt_key') && c.value && c.value !== 'deleted');
      const isOnVerifyOrLogin =
        curUrl.includes('aq.jd.com') ||
        curUrl.includes('safe.jd.com') ||
        curUrl.includes('cfe.m.jd.com');

      if (hasCore && !isOnVerifyOrLogin) {
        const saved = await syncCookiesFromHeadlessContext({}, source, { mobile });
        activeJdQrSession = null;
        return {
          state: 'logged_in',
          code: 200,
          nickname: saved.nickname,
          pin: saved.pin,
          mobile: saved.mobile,
          source: saved.source,
          updatedAt: saved.updatedAt,
          lastKeepAliveAt: saved.lastKeepAliveAt,
          cookieCount: Object.keys(saved.cookies).length,
          storagePath: getJdSessionFilePath(),
          message: `京东验证与登录已完成（账号：${saved.nickname}，共 ${Object.keys(saved.cookies).length} 项 Cookie 已持久保存）`,
        };
      }
    } else {
      const tbCookies = await context.cookies([
        'https://www.taobao.com',
        'https://www.tmall.com',
        'https://login.taobao.com',
      ]);
      const hasCore = tbCookies.some(
        c => (c.name === 'uc3' || c.name === 'sgcookie' || c.name === 'cookie17') && c.value && c.value !== 'deleted',
      );
      const leftLogin =
        curUrl !== 'about:blank' &&
        !curUrl.includes('login.taobao.com') &&
        !curUrl.includes('login.m.taobao.com') &&
        (curUrl.includes('taobao.com') || curUrl.includes('tmall.com'));

      if (hasCore && leftLogin) {
        const saved = await syncTaobaoCookiesFromHeadlessContext({}, source, mobile);
        activeTaobaoQrSession = null;
        return {
          state: 'logged_in',
          code: 200,
          nickname: saved.nick,
          pin: saved.uid,
          mobile: saved.mobile,
          source: saved.source,
          updatedAt: saved.updatedAt,
          lastKeepAliveAt: saved.lastKeepAliveAt,
          cookieCount: Object.keys(saved.cookies).length,
          storagePath: getTaobaoSessionFilePath(),
          message: `淘宝验证与登录已完成（账号：${saved.nick}，共 ${Object.keys(saved.cookies).length} 项 Cookie 已持久保存）`,
        };
      }
    }

    const buf = await page.screenshot({ type: 'jpeg', quality: 78 }).catch(() => null);
    const screenshot = buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : '';
    const title = await page.title().catch(() => '');

    return {
      state: 'verify_required',
      url: curUrl,
      title,
      screenshot,
      viewport: { width: 1280, height: 800 },
      message:
        platform === 'jd'
          ? '京东云端实时交互画面已就绪：可直接在画面中点击、拖动滑块、输入验证码或完成安全认证，登录成功后将自动保存会话'
          : '淘宝云端实时交互画面已就绪：可直接在画面中拖动滑块、点击按钮或扫码登录，登录成功后将自动保存会话',
    };
  }

  /**
   * 0a. 启动或打开云端实时可视化浏览器交互画面（用于直接过人机验证、异地安全认证或可视化登录）
   */
  @Post(':platform/remote/start')
  async startRemoteBrowser(
    @Param('platform') input: string,
    @Body() body: { targetUrl?: string; keepCurrent?: boolean },
    @Req() req: Request,
  ) {
    validateOrigin(req);
    const platform = platformOf(input);
    await this.getOrCreateRemotePage(platform, {
      targetUrl: body?.targetUrl,
      keepCurrent: body?.keepCurrent ?? true,
    });
    return this.captureRemoteFrameAndCheckAuth(platform);
  }

  /**
   * 0b. 获取云端实时浏览器最新画面帧并自动检测是否已完成验证/登录
   */
  @Get(':platform/remote/frame')
  async getRemoteBrowserFrame(@Param('platform') input: string, @Req() req: Request) {
    validateOrigin(req);
    const platform = platformOf(input);
    return this.captureRemoteFrameAndCheckAuth(platform);
  }

  /**
   * 0c. 在云端实时浏览器画面上执行用户鼠标点击、滑块拖拽、键盘输入或滚动操作
   */
  @Post(':platform/remote/action')
  async performRemoteBrowserAction(
    @Param('platform') input: string,
    @Body()
    body: {
      type: 'click' | 'drag' | 'type' | 'key' | 'scroll' | 'reload' | 'goto';
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
      url?: string;
    },
    @Req() req: Request,
  ) {
    validateOrigin(req);
    const platform = platformOf(input);
    const page = await this.getOrCreateRemotePage(platform, { keepCurrent: true });

    try {
      switch (body.type) {
        case 'click': {
          const x = Math.max(0, Math.min(1280, Math.round(Number(body.x) || 0)));
          const y = Math.max(0, Math.min(800, Math.round(Number(body.y) || 0)));
          await page.mouse.click(x, y, { delay: 35 });
          break;
        }
        case 'drag': {
          const pts =
            Array.isArray(body.path) && body.path.length >= 2
              ? body.path
              : [
                  { x: Number(body.fromX) || 0, y: Number(body.fromY) || 0 },
                  { x: Number(body.toX) || 0, y: Number(body.toY) || 0 },
                ];
          const first = pts[0];
          const startX = Math.max(0, Math.min(1280, Math.round(first.x)));
          const startY = Math.max(0, Math.min(800, Math.round(first.y)));
          await page.mouse.move(startX, startY);
          await page.waitForTimeout(40);
          await page.mouse.down();
          await page.waitForTimeout(50);

          if (pts.length > 2) {
            for (let i = 1; i < pts.length; i++) {
              const px = Math.max(0, Math.min(1280, Math.round(pts[i].x)));
              const py = Math.max(0, Math.min(800, Math.round(pts[i].y)));
              await page.mouse.move(px, py, { steps: 2 });
              await page.waitForTimeout(12);
            }
          } else {
            const end = pts[pts.length - 1];
            const endX = Math.max(0, Math.min(1280, Math.round(end.x)));
            const endY = Math.max(0, Math.min(800, Math.round(end.y)));
            const steps = 18;
            for (let s = 1; s <= steps; s++) {
              const progress = 1 - Math.pow(1 - s / steps, 2.2);
              const curX = Math.round(startX + (endX - startX) * progress);
              const curY = Math.round(startY + (endY - startY) * progress + Math.sin(s * 0.5) * 1.5);
              await page.mouse.move(curX, curY);
              await page.waitForTimeout(14);
            }
          }
          await page.waitForTimeout(60);
          await page.mouse.up();
          break;
        }
        case 'type': {
          if (body.text) {
            await page.keyboard.type(String(body.text), { delay: 30 });
          }
          break;
        }
        case 'key': {
          if (body.key) {
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
        case 'goto': {
          if (body.url) {
            await page.goto(String(body.url), { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          }
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
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            return (await r.json()) as { returnCode?: number; url?: string };
          }, ticket);

          if (valJson.url) {
            const targetUrl = valJson.url.startsWith('//')
              ? `https:${valJson.url}`
              : valJson.url.startsWith('/')
                ? `https://passport.jd.com${valJson.url}`
                : valJson.url;
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 16000 }).catch(() => {});
            await page.waitForTimeout(1000).catch(() => {});
          }
        } catch {
          // ignore headless ticket validation error, will run direct validation below
        }

        if (valJson.returnCode !== 0 && !valJson.url) {
          try {
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

            if (valJson.url && headlessLoginPage && !headlessLoginPage.isClosed()) {
              const targetUrl = valJson.url.startsWith('//')
                ? `https:${valJson.url}`
                : valJson.url.startsWith('/')
                  ? `https://passport.jd.com${valJson.url}`
                  : valJson.url;
              await headlessLoginPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 16000 }).catch(() => {});
              await headlessLoginPage.waitForTimeout(1000).catch(() => {});
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

        if (!hasCoreAuth) {
          activeJdQrSession = null;
          const frame = await this.captureRemoteFrameAndCheckAuth('jd', 'qrcode');
          if (frame.state === 'logged_in') {
            return frame;
          }
          return {
            ...frame,
            state: 'verify_required',
            code: valJson.returnCode ?? 58,
            message:
              '扫码已确认，京东触发异地/服务器新设备安全验证 (aq.jd.com)，已为您自动打开下方云端实时验证画面，请直接在画面中完成验证后自动同步完整登录态',
          };
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
          message: `京东扫码登录成功（账号：${saved.nickname}，共 ${Object.keys(saved.cookies).length} 项 Cookie），登录态已长期保存在服务端`,
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

    const page = await getOrOpenHeadlessJdLoginPage(true);

    // 切换到短信登录视图并填入手机号
    await page
      .evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('a, div, span, li'));
        const smsTab = tabs.find(el => {
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

    const mobileSelector = '#mobile-number, input[placeholder*="手机号"], input[name="mobile"]';
    await page.fill(mobileSelector, mobile).catch(async () => {
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
          (document.querySelector('#sendMobileCode, .msg-btn, .get-code-btn') as HTMLElement | null) ||
          (Array.from(document.querySelectorAll('button, a, div, span')).find(
            el => (el.textContent || '').trim() === '获取验证码',
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
            '#mobile-code, #authcode, input[placeholder*="验证码"]',
          ) as HTMLInputElement | null;
          if (cInput) {
            cInput.value = smsCode;
            cInput.dispatchEvent(new Event('input', { bubbles: true }));
            cInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const agree = document.querySelector('#agreeCheck, .policy_tip-checkbox') as HTMLInputElement | null;
          if (agree && !agree.checked) agree.click();

          const loginBtn = document.querySelector(
            '#sms-login-submit, #loginsubmit, .btn-img.btn-entry',
          ) as HTMLElement | null;
          if (loginBtn) loginBtn.click();
        },
        { phone: mobile, smsCode: code },
      )
      .catch(() => {});

    await page.waitForTimeout(1200);

    // 2. 若页面未自动跳转，调用带 h5st 签名的 /uc/mobile/loginService
    if (page.url().includes('passport.jd.com/new/login.aspx')) {
      const loginResult = await page
        .evaluate(
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
            return await res.text();
          },
          { phone: mobile, smsCode: code },
        )
        .catch(() => '');

      if (loginResult) {
        try {
          const cleaned = loginResult.trim().replace(/^\(/, '').replace(/\)$/, '');
          const parsed = JSON.parse(cleaned) as Record<string, string>;
          const targetUrl = parsed.success || parsed.newSafeVerify || parsed.url;
          if (targetUrl) {
            const fullUrl = targetUrl.startsWith('//') ? `https:${targetUrl}` : targetUrl;
            await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(1000).catch(() => {});
          }
        } catch {
          // ignore
        }
      }
    }

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
    const hasCoreAuthCookie = Boolean(session.cookies.thor || session.cookies.pt_key);
    if (verified.authenticated || (hasCoreAuthCookie && Object.keys(verified.refreshedCookies).length > 0)) {
      const updated = savePersistedJdSession({
        ...session,
        pin: verified.pin || session.pin,
        nickname: verified.nickname || session.nickname,
        cookies: {
          ...session.cookies,
          ...verified.refreshedCookies,
        },
        hadValidAuth: true,
        expiredNotifiedAt: undefined,
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

    if (hasCoreAuthCookie) {
      const cookieCount = Object.keys(session.cookies).length;
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

    // 仅当之前确实成功登录过 (hadValidAuth === true) 且尚未发送过失效通知时，才发送一次飞书告警，防止未完成验证的半成品会话反复刷屏推送
    if (session.hadValidAuth && !session.expiredNotifiedAt) {
      savePersistedJdSession({
        ...session,
        expiredNotifiedAt: new Date().toISOString(),
      });
      void notifySessionExpiredToFeishu('jd', '服务端京东核心登录 Cookie (thor) 已过期，请重新扫码登录');
    }

    return {
      state: 'login_required',
      message: '京东核心登录凭证 (thor) 尚未同步或已过期，请使用下方「京东扫码登录」或「云端实时交互画面」完成登录与安全验证',
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

  /**
   * 6b. 退出京东账号并清除服务端持久化 Cookie
   */
  @Post('jd/logout')
  async logoutJd(@Req() req: Request) {
    validateOrigin(req);
    const filePath = getJdSessionFilePath();
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // ignore unlink error
      }
    }
    activeJdQrSession = null;
    if (headlessAuthContext) {
      const jdCookies = await headlessAuthContext
        .cookies(['https://www.jd.com', 'https://passport.jd.com', 'https://item.jd.com', 'https://m.jd.com'])
        .catch(() => []);
      for (const c of jdCookies) {
        await headlessAuthContext
          .addCookies([{ name: c.name, value: '', domain: c.domain, path: c.path, expires: 0 }])
          .catch(() => {});
      }
    }
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
    const context = await getTaobaoHeadlessContext();
    if (!headlessTbPage || headlessTbPage.isClosed()) {
      headlessTbPage = await context.newPage();
      await headlessTbPage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
    }
    const page = headlessTbPage;

    let capturedGen: { t?: number; ck?: string; codeContent?: string; resultCode?: number } | null = null;

    const onResponse = async (res: { url: () => string; json: () => Promise<unknown> }) => {
      const u = res.url();
      if (u.includes('qrCode/generate.do')) {
        try {
          const json = (await res.json()) as {
            content?: { data?: { t?: number; ck?: string; codeContent?: string; resultCode?: number } };
          };
          if (json?.content?.data?.ck) {
            capturedGen = json.content.data;
          }
        } catch {
          // ignore
        }
      } else if (u.includes('qrCode/query.do') && activeTaobaoQrSession) {
        try {
          const json = (await res.json()) as {
            content?: {
              data?: {
                qrCodeStatus?: 'NEW' | 'SCANED' | 'CONFIRMED' | 'EXPIRED' | 'CANCELED' | 'ERROR';
                titleMsg?: string;
                redirectUrl?: string;
                iframeRedirectUrl?: string;
                asyncUrls?: string[];
              };
            };
          };
          const d = json?.content?.data;
          if (d?.qrCodeStatus) {
            activeTaobaoQrSession.lastStatus = d.qrCodeStatus;
            activeTaobaoQrSession.lastMessage = d.titleMsg || '';
            const targetRedirect = d.redirectUrl || d.iframeRedirectUrl || d.asyncUrls?.[0];
            if (targetRedirect) {
              activeTaobaoQrSession.redirectUrl = targetRedirect;
            }
          }
        } catch {
          // ignore
        }
      }
    };

    page.removeAllListeners('response');
    page.on('response', onResponse);

    await page.goto(TB_LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 22000 });

    const canvasLoc = page.locator('canvas').first();
    for (let attempt = 0; attempt < 25; attempt++) {
      const visible = await canvasLoc.isVisible().catch(() => false);
      if (visible) break;
      await page
        .evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a, div, span, i'));
          const otherLink = candidates.find(el => {
            const txt = (el.textContent || '').trim();
            return txt === '使用其他账号登录' || txt === '其他账号登录' || txt === '扫码登录';
          }) as HTMLElement | undefined;
          if (otherLink) {
            otherLink.click();
            return;
          }
          const qrIcon = document.querySelector('.icon-qrcode, .J_Quick2Static') as HTMLElement | null;
          if (qrIcon) qrIcon.click();
        })
        .catch(() => {});
      await page.waitForTimeout(250);
    }

    await canvasLoc.waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(250);

    const meta = await page
      .evaluate(async () => {
        const w = window as unknown as {
          viewData?: { loginFormData?: { _csrf?: string } };
        };
        const csrf = w.viewData?.loginFormData?._csrf || '';
        return { csrf };
      })
      .catch(() => ({ csrf: '' }));

    for (let waitAttempt = 0; waitAttempt < 12 && !capturedGen; waitAttempt++) {
      await page.waitForTimeout(150);
    }

    const pngBuffer = await canvasLoc.screenshot({ type: 'png' });
    const qrImage = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    const now = Date.now();
    const genInfo = (capturedGen || {}) as { t?: number; ck?: string; codeContent?: string };
    const tVal = genInfo.t || now;
    const ckVal = genInfo.ck || `qr_code_sm2_${now}`;
    const codeContentVal =
      genInfo.codeContent ||
      `https://login.m.taobao.com/qrcodeCheck.htm?lgToken=${ckVal}&tbScanOpenType=Notification`;

    activeTaobaoQrSession = {
      t: tVal,
      ck: ckVal,
      codeContent: codeContentVal,
      csrf: meta.csrf,
      qrImage,
      createdAt: now,
      expiresAt: now + 120_000,
      lastStatus: 'NEW',
      lastMessage: '二维码未扫描，请打开手机淘宝 App 扫码登录',
    };

    return {
      state: 'qr_ready',
      qrImage,
      token: ckVal,
      t: tVal,
      codeContent: codeContentVal,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(activeTaobaoQrSession.expiresAt).toISOString(),
      protocol: {
        generateUrl: TB_QR_GENERATE_URL,
        queryUrl: TB_QR_QUERY_URL,
      },
      message: '请打开手机淘宝 App 扫描下方二维码登录',
    };
  }

  /**
   * 7b. 轮询淘宝二维码扫码状态
   */
  @Get('taobao/qrcode/status')
  async checkTaobaoQrStatus(@Req() req: Request) {
    validateOrigin(req);
    if (!activeTaobaoQrSession) {
      return {
        state: 'qr_none',
        code: 0,
        message: '当前没有进行中的淘宝扫码会话',
      };
    }

    if (Date.now() > activeTaobaoQrSession.expiresAt) {
      return {
        state: 'qr_expired',
        code: 103,
        qrCodeStatus: 'EXPIRED',
        message: '淘宝二维码已超时失效，请点击刷新重新获取二维码',
      };
    }

    if (headlessTbPage && !headlessTbPage.isClosed()) {
      const pageUrl = headlessTbPage.url();
      if (
        !pageUrl.includes('login.taobao.com') &&
        (pageUrl.includes('taobao.com') || pageUrl.includes('tmall.com'))
      ) {
        activeTaobaoQrSession.lastStatus = 'CONFIRMED';
      } else if (activeTaobaoQrSession.lastStatus === 'NEW' || activeTaobaoQrSession.lastStatus === 'SCANED') {
        const queryData = await headlessTbPage
          .evaluate(
            async ({ t, ck, csrf }: { t: number; ck: string; csrf: string }) => {
              const body = new URLSearchParams({
                t: String(t),
                ck,
                ua: '',
                sub: 'true',
                hitRSA2048Gray: 'true',
                bizEntrance: 'taobao_pc',
                bizName: 'taobao',
                _csrf: csrf,
                lang: 'zh_CN',
                umidToken: '',
                umidTag: 'NOT_INIT',
                navlanguage: 'zh-CN',
                navUserAgent: navigator.userAgent,
                navPlatform: navigator.platform || 'MacIntel',
                isIframe: 'false',
                banThirdPartyCookie: 'true',
                documentReferer: '',
                defaultView: 'qrcode',
              });
              const r = await fetch('/havanaone/loginLegacy/qrCode/query.do?bizEntrance=taobao_pc&bizName=taobao', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
              });
              const j = (await r.json()) as {
                content?: {
                  data?: {
                    qrCodeStatus?: 'NEW' | 'SCANED' | 'CONFIRMED' | 'EXPIRED' | 'CANCELED' | 'ERROR';
                    titleMsg?: string;
                    redirectUrl?: string;
                    iframeRedirectUrl?: string;
                    asyncUrls?: string[];
                  };
                };
              };
              if (j?.content?.data?.qrCodeStatus === 'CONFIRMED') {
                const w = window as unknown as {
                  miniLogin?: { handleLoginResult?: (data: unknown) => void };
                };
                try {
                  w.miniLogin?.handleLoginResult?.(j.content.data);
                } catch {
                  // ignore
                }
                const asyncUrls = j.content.data.asyncUrls || [];
                for (const url of asyncUrls) {
                  try {
                    await fetch(url, { credentials: 'include', mode: 'no-cors' });
                  } catch {
                    // ignore
                  }
                }
              }
              return j?.content?.data || null;
            },
            {
              t: activeTaobaoQrSession.t,
              ck: activeTaobaoQrSession.ck,
              csrf: activeTaobaoQrSession.csrf,
            },
          )
          .catch(() => null);

        if (queryData?.qrCodeStatus) {
          activeTaobaoQrSession.lastStatus = queryData.qrCodeStatus;
          activeTaobaoQrSession.lastMessage = queryData.titleMsg || activeTaobaoQrSession.lastMessage;
          const targetRedirect = queryData.redirectUrl || queryData.iframeRedirectUrl || queryData.asyncUrls?.[0];
          if (targetRedirect) {
            activeTaobaoQrSession.redirectUrl = targetRedirect;
          }
        }
      }
    }

    switch (activeTaobaoQrSession.lastStatus) {
      case 'NEW':
        return {
          state: 'qr_waiting',
          code: 100,
          qrCodeStatus: 'NEW',
          message: activeTaobaoQrSession.lastMessage || '二维码未扫描，请打开手机淘宝 App 扫一扫',
        };
      case 'SCANED':
        return {
          state: 'qr_scanned',
          code: 101,
          qrCodeStatus: 'SCANED',
          message: '扫描成功！请在手机淘宝 App 上点击「确认登录」',
        };
      case 'EXPIRED':
        return {
          state: 'qr_expired',
          code: 103,
          qrCodeStatus: 'EXPIRED',
          message: '淘宝二维码已失效，请点击刷新二维码',
        };
      case 'CANCELED':
      case 'ERROR':
        return {
          state: 'qr_cancelled',
          code: 105,
          qrCodeStatus: activeTaobaoQrSession.lastStatus,
          message: activeTaobaoQrSession.lastMessage || '已在手机端取消扫码登录，请重新获取二维码',
        };
      case 'CONFIRMED': {
        if (headlessTbPage && !headlessTbPage.isClosed()) {
          await headlessTbPage.waitForTimeout(800).catch(() => {});
          if (activeTaobaoQrSession.redirectUrl) {
            await headlessTbPage
              .goto(activeTaobaoQrSession.redirectUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
              .catch(() => {});
          }
          await headlessTbPage
            .goto('https://login.taobao.com/member/login.jhtml?redirectURL=https%3A%2F%2Fwww.taobao.com%2F', {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            })
            .catch(() => {});
          await headlessTbPage
            .evaluate(() => {
              const btn = document.querySelector(
                '.has-login button, .has-login .fm-button, button.fm-button',
              ) as HTMLButtonElement | null;
              if (btn && (btn.textContent || '').includes('登录')) btn.click();
            })
            .catch(() => {});
          await headlessTbPage.waitForTimeout(1500).catch(() => {});
        }
        const saved = await syncTaobaoCookiesFromHeadlessContext({}, 'qrcode');
        activeTaobaoQrSession = null;
        return {
          state: 'logged_in',
          code: 200,
          qrCodeStatus: 'CONFIRMED',
          nickname: saved.nick,
          pin: saved.uid,
          source: saved.source,
          updatedAt: saved.updatedAt,
          lastKeepAliveAt: saved.lastKeepAliveAt,
          cookieCount: Object.keys(saved.cookies).length,
          storagePath: getTaobaoSessionFilePath(),
          message: `淘宝扫码登录成功（账号：${saved.nick}），登录态已长期保存在服务端`,
        };
      }
    }
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

    await page.fill('#fm-sms-login-id, input[name="fm-sms-login-id"]', mobile).catch(() => {});
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
    if (resultCode === 100 || sendRes?.content?.success) {
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

    await page.fill('#fm-sms-login-id, input[name="fm-sms-login-id"]', mobile).catch(() => {});
    await page.fill('#fm-smscode, input[name="fm-smscode"]', code).catch(() => {});
    await page
      .evaluate(() => {
        const agree = document.querySelector('#fm-agreement-checkbox') as HTMLInputElement | null;
        if (agree && !agree.checked) agree.click();
        const submitBtn = document.querySelector('button.sms-login, button.fm-submit') as HTMLElement | null;
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
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000).catch(() => {});
    }

    const frameOrAuth = await this.captureRemoteFrameAndCheckAuth('taobao', 'sms', mobile);
    if (frameOrAuth.state === 'logged_in') {
      return frameOrAuth;
    }

    if (resData?.resultCode === 100) {
      const saved = await syncTaobaoCookiesFromHeadlessContext({}, 'sms', mobile);
      activeTaobaoQrSession = null;
      return {
        state: 'logged_in',
        nickname: saved.nick,
        pin: saved.uid,
        mobile: saved.mobile,
        source: saved.source,
        updatedAt: saved.updatedAt,
        lastKeepAliveAt: saved.lastKeepAliveAt,
        cookieCount: Object.keys(saved.cookies).length,
        storagePath: getTaobaoSessionFilePath(),
        message: `淘宝手机号验证码登录成功（账号：${saved.nick}），登录态已长期保存在服务端`,
      };
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
    const hasCoreAuthCookie = Boolean(saved && (saved.cookies.uc3 || saved.cookies.sgcookie || saved.cookies.cookie17));
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
    const filePath = getTaobaoSessionFilePath();
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // ignore unlink error
      }
    }
    activeTaobaoQrSession = null;
    if (headlessAuthContext) {
      const tbCookies = await headlessAuthContext
        .cookies(['https://www.taobao.com', 'https://www.tmall.com', 'https://login.taobao.com'])
        .catch(() => []);
      for (const c of tbCookies) {
        await headlessAuthContext
          .addCookies([{ name: c.name, value: '', domain: c.domain, path: c.path, expires: 0 }])
          .catch(() => {});
      }
    }
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
