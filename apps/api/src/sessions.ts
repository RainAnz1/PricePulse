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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

const TB_LOGIN_PAGE_URL =
  'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&redirectURL=https%3A%2F%2Fwww.taobao.com%2F';
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

async function launchStealthPersistentContext(profileDir: string): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
  ];
  const baseOptions = {
    headless: true,
    userAgent: JD_UA,
    viewport: { width: 1366, height: 860 },
    args: launchArgs,
    extraHTTPHeaders: {
      'sec-ch-ua': '"Google Chrome";v="130", "Chromium";v="130", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  };

  let context: BrowserContext | null = null;
  const candidateBins = [
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
      // try next executable
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
 * 获取服务端常驻无头浏览器上下文（持久化 Profile + 自动注入已保存的 Cookie）
 * 用于执行京东 h5st 签名、Ticket 校验、短信验证码发送与登录，以及带登录态的商品价格采集
 */
export async function getJdHeadlessContext(): Promise<BrowserContext> {
  if (headlessAuthContext) {
    await ensureJdContextCookies(headlessAuthContext);
    return headlessAuthContext;
  }
  if (headlessAuthLaunching) return headlessAuthLaunching;

  const task = (async () => {
    const profileDir = getJdHeadlessProfilePath();
    const context = await launchStealthPersistentContext(profileDir);
    await ensureJdContextCookies(context);

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
  const browserCookies = await context.cookies([
    'https://www.jd.com',
    'https://passport.jd.com',
    'https://item.jd.com',
    'https://m.jd.com',
    'https://item.m.jd.com',
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

/**
 * 获取淘宝服务端常驻无头浏览器上下文（用于执行淘宝二维码生成、扫码状态轮询、短信验证码登录与商品详情采集）
 */
export async function getTaobaoHeadlessContext(): Promise<BrowserContext> {
  if (headlessTbContext) {
    await ensureTaobaoContextCookies(headlessTbContext);
    return headlessTbContext;
  }
  if (headlessTbLaunching) return headlessTbLaunching;

  const task = (async () => {
    const profileDir = getTaobaoHeadlessProfilePath();
    const context = await launchStealthPersistentContext(profileDir);
    await ensureTaobaoContextCookies(context);

    headlessTbContext = context;
    context.on('close', () => {
      if (headlessTbContext === context) {
        headlessTbContext = null;
        headlessTbPage = null;
      }
    });
    return context;
  })();

  headlessTbLaunching = task;
  try {
    return await task;
  } finally {
    headlessTbLaunching = null;
  }
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

        // 1. 先在无头浏览器加载完登录页后再注入当前二维码的 wlfstk_smdl / QRCodeKey，防止页面初始化请求覆盖二维码 Cookie
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

          if (valJson.url && valJson.returnCode === 0) {
            await page.goto(valJson.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          }
        } catch {
          // ignore headless ticket validation error, will run direct validation below
        }

        // 2. 若无头页面未成功拿到 returnCode === 0，执行服务端直连 Ticket 校验兜底并将 Set-Cookie (含 thor) 同步回无头上下文
        if (valJson.returnCode !== 0) {
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
          } catch {
            // ignore fallback network error
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

    void notifySessionExpiredToFeishu('jd', '服务端京东核心登录 Cookie (thor) 已失效或缺失，请重新扫码登录');
    return {
      state: 'login_required',
      message: '京东核心登录凭证 (thor) 缺失或已过期，请使用下方「京东扫码登录」重新扫码以同步完整服务端会话',
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
      await headlessAuthContext.clearCookies().catch(() => {});
    }
    const jdBrowser = contexts.get('jd');
    if (jdBrowser) {
      await jdBrowser.clearCookies().catch(() => {});
    }
    return {
      state: 'login_required',
      nickname: '未登录',
      pin: '—',
      cookieCount: 0,
      message: '已退出京东账号，服务端持久化登录态已清除',
    };
  }

  /**
   * 7. 获取淘宝网页内扫码登录二维码
   * 底层协议：GET https://login.taobao.com/havanaone/loginLegacy/qrCode/generate.do?bizEntrance=taobao_pc&bizName=taobao
   * 返回字段：{ hasError: false, content: { status: 0, data: { t, codeContent, ck, resultCode: 100 }, success: true } }
   */
  @Post('taobao/qrcode/start')
  async startTaobaoQrCode(@Req() req: Request) {
    validateOrigin(req);
    const context = await getTaobaoHeadlessContext();
    if (!headlessTbPage || headlessTbPage.isClosed()) {
      headlessTbPage = await context.newPage();
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

    await page.goto(TB_LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // 如果当前页面处于快速确认登录视图 (hasLogin)，点击“使用其他账号登录”切换到二维码视图
    await page
      .evaluate(() => {
        const otherLink = Array.from(document.querySelectorAll('a')).find(a =>
          (a.textContent || '').includes('使用其他账号登录'),
        );
        if (otherLink) otherLink.click();
      })
      .catch(() => {});

    const canvasLoc = page.locator('canvas').first();
    await canvasLoc.waitFor({ state: 'visible', timeout: 10000 });
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

    // 等待页面自身发出的 generate.do 响应返回（不要二次主动请求 generate.do，以免服务端 ck 与画布上的二维码不一致）
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
   * 底层协议：POST https://login.taobao.com/havanaone/loginLegacy/qrCode/query.do?bizEntrance=taobao_pc&bizName=taobao
   * 请求体：t={t}&ck={ck}&sub=true&hitRSA2048Gray=true&bizEntrance=taobao_pc&bizName=taobao&_csrf={_csrf}&lang=zh_CN
   * 返回体：{ hasError: false, content: { status: 0, data: { qrCodeStatus: "NEW"|"SCANED"|"CONFIRMED"|"EXPIRED"|"CANCELED", titleMsg, resultCode: 100 } } }
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

    // 检查无头页面是否已完成扫码跳转或下发了最新 query.do 状态
    if (headlessTbPage && !headlessTbPage.isClosed()) {
      const pageUrl = headlessTbPage.url();
      if (
        !pageUrl.includes('login.taobao.com') &&
        (pageUrl.includes('taobao.com') || pageUrl.includes('tmall.com'))
      ) {
        activeTaobaoQrSession.lastStatus = 'CONFIRMED';
      } else if (activeTaobaoQrSession.lastStatus === 'NEW' || activeTaobaoQrSession.lastStatus === 'SCANED') {
        // 在无头页面上下文中调用一次 query.do 获取最新实时状态
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
            await headlessTbPage.waitForTimeout(1000).catch(() => {});
            if (activeTaobaoQrSession.redirectUrl) {
              await headlessTbPage
                .goto(activeTaobaoQrSession.redirectUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
                .catch(() => {});
            }
            await headlessTbPage
              .goto('https://www.taobao.com/', { waitUntil: 'domcontentloaded', timeout: 12000 })
              .catch(() => {});
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
   * 底层协议：POST https://login.taobao.com/havanaone/loginLegacy/sms/sendSms.do?bizEntrance=taobao_pc&bizName=taobao
   */
  @Post('taobao/sms/send')
  async sendTaobaoSmsCode(@Body() body: { mobile?: string }, @Req() req: Request) {
    validateOrigin(req);
    const mobile = (body?.mobile || '').trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new BadRequestException('请输入有效的 11 位中国大陆手机号码');
    }

    const context = await getTaobaoHeadlessContext();
    if (!headlessTbPage || headlessTbPage.isClosed()) {
      headlessTbPage = await context.newPage();
      await headlessTbPage.goto(TB_LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    const page = headlessTbPage;
    if (!page.url().includes('login.taobao.com')) {
      await page.goto(TB_LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    // 切换到短信验证码登录 Tab
    await page
      .evaluate(() => {
        const otherLink = Array.from(document.querySelectorAll('a')).find(a =>
          (a.textContent || '').includes('使用其他账号登录'),
        );
        if (otherLink) otherLink.click();
        const smsTab = document.querySelector('.sms-login-tab-item') as HTMLElement | null;
        if (smsTab) smsTab.click();
      })
      .catch(() => {});

    await page.waitForTimeout(400);

    let sendApiRes: { content?: { data?: { resultCode?: number; titleMsg?: string }; success?: boolean } } | null =
      null;
    const responsePromise = page
      .waitForResponse(res => res.url().includes('sms/sendSms.do'), { timeout: 8000 })
      .then(async res => {
        sendApiRes = (await res.json()) as {
          content?: { data?: { resultCode?: number; titleMsg?: string }; success?: boolean };
        };
      })
      .catch(() => {});

    await page.fill('#fm-sms-login-id', mobile).catch(() => {});
    await page
      .evaluate(() => {
        const agree = document.querySelector('#fm-agreement-checkbox') as HTMLInputElement | null;
        if (agree && !agree.checked) agree.click();
        const sendBtn = document.querySelector('.send-btn-link') as HTMLElement | null;
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

    const errMsg =
      sendRes?.content?.data?.titleMsg ||
      '淘宝短信接口触发滑块安全验证，请优先切换至「淘宝 App 扫码登录」直接扫码';
    throw new BadRequestException(errMsg);
  }

  /**
   * 7d. 淘宝手机号短信验证码登录 — 提交验证码并持久化 Cookie
   * 底层协议：POST https://login.taobao.com/havanaone/loginLegacy/sms/login.do?bizEntrance=taobao_pc&bizName=taobao
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

    if (!headlessTbPage || headlessTbPage.isClosed()) {
      throw new BadRequestException('请先点击「获取验证码」发送短信');
    }
    const page = headlessTbPage;

    let loginApiRes: {
      content?: {
        data?: { resultCode?: number; titleMsg?: string; redirectUrl?: string; iframeRedirectUrl?: string };
        success?: boolean;
      };
    } | null = null;

    const responsePromise = page
      .waitForResponse(res => res.url().includes('sms/login.do'), { timeout: 10000 })
      .then(async res => {
        loginApiRes = (await res.json()) as {
          content?: {
            data?: { resultCode?: number; titleMsg?: string; redirectUrl?: string; iframeRedirectUrl?: string };
            success?: boolean;
          };
        };
      })
      .catch(() => {});

    await page.fill('#fm-sms-login-id', mobile).catch(() => {});
    await page.fill('#fm-smscode', code).catch(() => {});
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
    if (resData?.resultCode === 100 || (!page.url().includes('login.taobao.com') && page.url().includes('taobao.com'))) {
      const targetUrl = resData?.redirectUrl || resData?.iframeRedirectUrl;
      if (targetUrl) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
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

    throw new BadRequestException(resData?.titleMsg || '淘宝短信验证码错误或已失效，请重试或使用扫码登录');
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
    if (headlessTbContext) {
      await headlessTbContext.clearCookies().catch(() => {});
    }
    const tbBrowser = contexts.get('taobao');
    if (tbBrowser) {
      await tbBrowser.clearCookies().catch(() => {});
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
      const jdStatus = await this.getJdStatus();
      if (jdStatus.state === 'logged_in') {
        return jdStatus;
      }
    }

    const context = contexts.get(platform);
    if (!context) {
      if (platform === 'taobao') {
        const tbStatus = await this.getTaobaoStatus();
        if (tbStatus.state === 'logged_in') return tbStatus;
      }
      return {
        state: 'unknown',
        message:
          platform === 'jd'
            ? '未检测到有效京东登录态，请使用「京东扫码登录」或「手机号验证码登录」'
            : '尚未检测到淘宝登录窗口，请先点击「打开淘宝扫码登录」',
      };
    }

    if (platform === 'taobao') {
      try {
        const allCookies = await context.cookies(['https://www.taobao.com', 'https://www.tmall.com']);
        const cookieMap: Record<string, string> = {};
        for (const c of allCookies) {
          if (c.name && c.value) cookieMap[c.name] = c.value;
        }
        const rawNick = decodeCookieValue(cookieMap.tracknick || cookieMap._nk_ || cookieMap.lgc || '');
        const hasAuth = Boolean(cookieMap.cookie2 || cookieMap._tb_token_ || cookieMap.unb || rawNick);
        if (hasAuth && Object.keys(cookieMap).length > 3) {
          const saved = savePersistedTaobaoSession({
            platform: 'taobao',
            nick: rawNick || '淘宝已登录用户',
            uid: cookieMap.unb || rawNick || 'tb_user',
            cookies: cookieMap,
            cookieHeader: buildCookieHeader(cookieMap),
            updatedAt: new Date().toISOString(),
            lastKeepAliveAt: new Date().toISOString(),
          });
          return {
            state: 'logged_in',
            nickname: saved.nick,
            pin: saved.uid,
            updatedAt: saved.updatedAt,
            lastKeepAliveAt: saved.lastKeepAliveAt,
            cookieCount: Object.keys(saved.cookies).length,
            message: `已同步并保存淘宝登录态至服务端（账号：${saved.nick}，共 ${
              Object.keys(saved.cookies).length
            } 项 Cookie）`,
          };
        }
      } catch {
        // fall through to page check
      }
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
