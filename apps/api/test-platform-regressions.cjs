const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { readJdDisplayedPrice, resolveJdPrice } = require('./dist/jd-price');
const { scrapeJdProduct } = require('./dist/jd-product');
const { saveFeishuConfig } = require('./dist/feishu');
const { ProductsController, scrapeAndUpsertProduct } = require('./dist/products');
const { RemoteBrowserControls } = require('./dist/remote-browser-controls');
const sessionModule = require('./dist/sessions');
const {
  SessionsController,
  loadPersistedJdSession,
  runJdSessionKeepAlive,
  savePersistedJdSession,
  savePersistedTaobaoSession,
} = require('./dist/sessions');

test('JD uses the displayed offer in either order and preserves a lower reference price', () => {
  assert.deepEqual(readJdDisplayedPrice('¥699 到手价 ¥799'), { price: 699, subsidy: false });
  assert.deepEqual(readJdDisplayedPrice('京东价 ¥599\n预估到手价：￥699'), { price: 699, subsidy: false });
  assert.deepEqual(readJdDisplayedPrice('国补领后价 ¥1,279.99'), { price: 1279.99, subsidy: true });
  assert.deepEqual(readJdDisplayedPrice('¥2,898 国补领后价 ¥3,698 补贴价'), { price: 2898, subsidy: true });
  assert.deepEqual(readJdDisplayedPrice('京东价 ¥699\n满500减50'), { price: 0, subsidy: false });
  assert.deepEqual(resolveJdPrice({ displayed: 699, quotedOffer: 659, selling: 649, original: 799 }), {
    finalPrice: 699, pagePrice: 799,
  });
});

test('saved price histories remove legacy simulations and rebuild stats from the collected samples', t => {
  const previousRoot = process.env.LOCALAPPDATA;
  const root = mkdtempSync(join(tmpdir(), 'pricepulse-history-'));
  process.env.LOCALAPPDATA = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  const points = (timestamp, pagePrice, finalPrice, note) => ({
    timestamp, pagePrice, finalPrice, note, couponPrice: null, subsidyPrice: null, inStock: true,
  });
  const first = points('2026-11-25T10:00:00.000Z', 130, 110, '首次添加采集');
  const latest = points('2026-11-26T10:00:00.000Z', 120, 99, '实时巡检采集');
  const mockNotes = ['历史参考价', '近期日常价', '每日历史巡检', '促销调价记录', '国补生效巡检', '降价触发 (-¥20)'];
  const mocks = mockNotes.map(note => points('2026-11-27T10:00:00.000Z', 999, 1, note));
  const legacy = {
    key: 'taobao:123456:4321',
    title: '现有商品',
    historySource: 'fetched_or_realtime',
    priceHistory: [mocks[0], first, ...mocks.slice(1, 5), latest, mocks[5]],
    allTimeLow: 1, allTimeHigh: 999, allTimeLowAt: mocks[0].timestamp,
    pagePrice: 999, finalPrice: 1, initialPrice: 999, previousFinalPrice: 20, lastDropAmount: 19,
    updatedAt: mocks[5].timestamp,
  };
  const dir = join(root, 'PriceDrop', 'data');
  const file = join(dir, 'products.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify([
    legacy,
    { ...legacy, key: 'jd:123456:123456', priceHistory: mocks },
    {
      ...legacy, key: 'jd:223456:223456', platform: 'jd', historySource: 'realtime',
      priceHistory: [points(latest.timestamp, 3698, 3698, '首次添加采集')],
    },
  ]));
  const controller = new ProductsController();

  const [product, empty, baseOnly] = controller.list().products;
  assert.equal(product.title, legacy.title);
  assert.deepEqual(product.priceHistory, [first, latest]);
  assert.equal(product.allTimeLow, 99);
  assert.equal(product.allTimeLowAt, latest.timestamp);
  assert.equal(product.allTimeHigh, 130);
  assert.equal(product.finalPrice, 99);
  assert.equal(product.previousFinalPrice, 110);
  assert.equal(empty.allTimeLow, null);
  assert.equal(empty.allTimeHigh, null);
  assert.deepEqual(empty.priceHistory, []);
  assert.equal(baseOnly.pagePrice, 3698);
  assert.equal(baseOnly.finalPrice, null);
  assert.equal(baseOnly.priceHistory[0].finalPrice, null);
  assert.equal(baseOnly.allTimeLow, null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), controller.list().products);
});

test('a collected low survives the chart window and later alerts compare actual observations', async t => {
  const previousRoot = process.env.LOCALAPPDATA;
  const root = mkdtempSync(join(tmpdir(), 'pricepulse-rolling-history-'));
  process.env.LOCALAPPDATA = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  const history = Array.from({ length: 180 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 10, 25, 0, index)).toISOString(),
    pagePrice: index === 0 ? 99 : 260,
    finalPrice: index === 0 ? 99 : 260,
    couponPrice: null,
    subsidyPrice: null,
    inStock: true,
    note: index === 0 ? '首次添加采集' : '实时巡检采集',
  }));
  const dir = join(root, 'PriceDrop', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'products.json'), JSON.stringify([{
    key: 'jd:12345678:12345678', platform: 'jd', historySource: 'observed', priceHistory: history,
    allTimeLow: 99, allTimeHigh: 260, allTimeLowAt: history[0].timestamp,
    initialPrice: 99, pagePrice: 260, finalPrice: 260, inStock: true,
  }]));

  let collectedPrice = 155;
  let desktopQuoteAvailable = true;
  t.mock.method(sessionModule, 'getJdHeadlessContext', async () => ({
    newPage: async () => ({
      on() {}, async goto() {}, async close() {}, async waitForTimeout() {},
      url: () => desktopQuoteAvailable ? 'https://item.jd.com/12345678.html' : 'https://pc-frequent-pro.pf.jd.com/',
      async evaluate(task) {
        if (!String(task).includes('priceAreaText')) return true;
        return {
          priceAreaText: `预估到手价 ¥${collectedPrice}`, quanAreaText: '', jpText: '260',
          pPriceText: '', pageOriginPriceText: '', handPriceElText: '',
        };
      },
    }),
  }));
  const alerts = [];
  t.mock.method(require('./dist/feishu'), 'notifyPriceDropToFeishu', async alert => {
    alerts.push(alert);
    return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(
    `window._itemInfo = (${JSON.stringify({
      product: { skuName: '京东测试商品' }, priceFloor: { ext: { jdPrice: String(collectedPrice) } },
    })});`,
  ));

  const url = 'https://item.jd.com/12345678.html';
  const { product } = await scrapeAndUpsertProduct(url);
  assert.equal(product.priceHistory.length, 180);
  assert.equal(product.priceHistory[0].timestamp, history[1].timestamp);
  assert.equal(product.allTimeLow, 99);
  assert.equal(product.allTimeLowAt, history[0].timestamp);
  assert.equal(new ProductsController().list().products[0].allTimeLow, 99);
  assert.equal(alerts[0].previousPrice, 260);
  assert.equal(alerts[0].isNewAllTimeLow, false);

  desktopQuoteAvailable = false;
  const { product: baseOnly } = await scrapeAndUpsertProduct(url);
  assert.equal(baseOnly.pagePrice, 155);
  assert.equal(baseOnly.finalPrice, null);
  assert.equal(baseOnly.allTimeLow, 99);
  assert.equal(alerts.length, 1);

  desktopQuoteAvailable = true;
  collectedPrice = 89;
  const { product: cheaper } = await scrapeAndUpsertProduct(url);
  assert.equal(cheaper.allTimeLow, 89);
  assert.equal(cheaper.allTimeLowAt, cheaper.priceHistory.at(-1).timestamp);
  assert.equal(alerts[1].previousPrice, 155);
  assert.equal(alerts[1].isNewAllTimeLow, true);
});

test('remote login rejects cross-origin requests and allows same-origin traffic through a proxy', async () => {
  const controller = new SessionsController();
  const request = (origin, site) => ({
    get: header => ({ origin, 'sec-fetch-site': site, host: 'pricepulse.internal' })[header],
  });
  const destination = { targetUrl: 'https://example.org' };
  await assert.rejects(controller.startRemoteBrowser('jd', destination, request('https://example.org', 'cross-site')), {
    status: 403,
  });
  await assert.rejects(controller.startRemoteBrowser('jd', destination, request('https://pricepulse.example.org', 'same-origin')), {
    status: 400,
  });
});

test('JD mobile login saves credentials only after returning to JD with both scoped cookies', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pricepulse-mobile-login-'));
  const oldRoot = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  const controller = new SessionsController();
  t.after(async () => {
    await controller.onModuleDestroy();
    if (oldRoot === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldRoot;
    rmSync(root, { recursive: true, force: true });
  });

  const cookie = (name, value) => ({
    name, value, domain: '.jd.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
  });
  const desktop = cookie('thor', 'desktop-fixture');
  const cookies = [desktop];
  savePersistedJdSession({ cookies: { thor: desktop.value } });
  const page = Object.assign(new EventEmitter(), {
    href: 'about:blank',
    closed: false,
    async goto(url) {
      assert.equal(url, 'https://my.m.jd.com/');
      this.href = 'https://plogin.m.jd.com/login/login?appid=300';
    },
    url() { return this.href; },
    isClosed() { return this.closed; },
    async close() { this.closed = true; this.emit('close'); },
    async screenshot() { return Buffer.from('fixture'); },
    async title() { return '京东'; },
  });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    async cookies(scope) {
      if (scope !== undefined) assert.equal(scope, 'https://item.m.jd.com/');
      return cookies;
    },
    async newPage() { return page; },
    async close() { this.emit('close'); },
  });
  t.mock.method(chromium, 'launchPersistentContext', async () => context);
  const request = { get: name => name === 'sec-fetch-site' ? 'same-origin' : undefined };
  const start = await controller.startRemoteBrowser('jd', { jdMobile: true }, request);
  assert.equal(start.state, 'verify_required');
  assert.equal(start.url, 'https://plogin.m.jd.com/login/login');

  page.href = 'https://my.m.jd.com/';
  cookies.push(cookie('pt_key', 'key-fixture'));
  assert.equal((await controller.getRemoteBrowserFrame('jd', request)).state, 'verify_required');
  assert.deepEqual(loadPersistedJdSession().cookies, { thor: desktop.value });

  cookies.push(cookie('pt_pin', 'mobile-fixture'));
  const saved = await controller.getRemoteBrowserFrame('jd', request);
  assert.equal(saved.state, 'logged_in');
  assert.equal(saved.mobileLoginReady, true);
  assert.deepEqual(loadPersistedJdSession().cookies, {
    thor: desktop.value, pt_key: 'key-fixture', pt_pin: 'mobile-fixture',
  });
  assert.equal(page.closed, true);

  t.mock.method(globalThis, 'fetch', async () => Response.json({ Identity: { IsAuthenticated: false } }));
  const status = await controller.getJdStatus();
  assert.equal(status.mobileLoginReady, true);
  assert.equal(loadPersistedJdSession().authExpiredAt, undefined);
});

test('temporary JD failures preserve the session and confirmed expiry sends one notification', async t => {
  const oldDataRoot = process.env.LOCALAPPDATA;
  const testRoot = mkdtempSync(join(tmpdir(), 'pricepulse-test-'));
  process.env.LOCALAPPDATA = testRoot;
  t.after(() => {
    if (oldDataRoot === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldDataRoot;
    rmSync(testRoot, { recursive: true, force: true });
  });

  saveFeishuConfig({
    webhookUrl: 'https://open.feishu.cn/example', secret: '', enabled: true,
    notifyOnSessionExpire: true, updatedAt: new Date().toISOString(),
  });
  let jdResult = 'offline';
  let alerts = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const host = new URL(input).hostname;
    if (host === 'open.feishu.cn') {
      alerts++;
      return Response.json({ code: 0, StatusCode: 0 });
    }
    if (jdResult === 'offline') throw new Error('temporary network failure');
    return host === 'passport.jd.com'
      ? Response.json({ Identity: { IsAuthenticated: jdResult === 'valid', Name: 'test', Unick: '测试账号' } })
      : Response.json({});
  });

  savePersistedJdSession({ cookies: { TrackID: 'tracking-only' } });
  assert.equal((await runJdSessionKeepAlive()).state, 'login_required');
  savePersistedJdSession({ cookies: { thor: 'fixture' } });
  assert.equal((await runJdSessionKeepAlive()).state, 'unverified');
  assert.equal(loadPersistedJdSession().cookies.thor, 'fixture');
  assert.equal(alerts, 0);

  jdResult = 'valid';
  assert.equal((await runJdSessionKeepAlive()).session.nickname, '测试账号');
  assert.ok(loadPersistedJdSession().lastVerifiedAt);
  jdResult = 'expired';
  const results = await Promise.all([runJdSessionKeepAlive(), runJdSessionKeepAlive()]);
  assert.deepEqual(results.map(result => result.state), ['login_required', 'login_required']);
  assert.equal((await runJdSessionKeepAlive()).state, 'login_required');
  assert.equal(alerts, 1);
  assert.ok(loadPersistedJdSession().authExpiredAt);

  savePersistedTaobaoSession({ cookies: { cookie17: 'id-only' } });
  assert.equal((await new SessionsController().getTaobaoStatus()).state, 'login_required');
  savePersistedTaobaoSession({ cookies: { sgcookie: 'fixture', tracknick: 'test' } });
  assert.equal((await new SessionsController().getTaobaoStatus()).state, 'logged_in');
});

test('Taobao product verification is reported separately from login expiry', async t => {
  const item = 'https://item.taobao.com/item.htm?id=123456&skuId=4321';
  const page = {
    on() {},
    off() {},
    async route() {},
    async goto() {},
    async waitForTimeout() {},
    url: () => item,
    evaluate: t.mock.fn(async () => ({ title: 'CAPTCHA Verification', priceReady: false })),
    close: t.mock.fn(async () => {}),
  };
  t.mock.method(sessionModule, 'getTaobaoHeadlessContext', async () => ({
    newPage: async () => page,
  }));

  await assert.rejects(scrapeAndUpsertProduct(item), error => {
    assert.equal(error.getResponse().code, 'TAOBAO_VERIFICATION_REQUIRED');
    assert.match(error.message, /商品页.*人机验证/);
    return true;
  });
  assert.equal(page.evaluate.mock.callCount(), 1);
  assert.equal(page.close.mock.callCount(), 1);
});

test('remote controls apply each batched pointer position in order before releasing', async () => {
  const events = [];
  const page = {
    viewportSize: () => ({ width: 100, height: 100 }),
    mouse: {
      async move(x, y) { events.push([x, y]); },
      async down() { events.push('pressed'); },
      async up() { events.push('released'); },
    },
  };
  const controls = new RemoteBrowserControls();
  const send = (type, payload) => controls.update(page, () => page, { id: 'fixture', type, ...payload });
  await send('down', { x: 1, y: 20 });
  try {
    await assert.rejects(send('move', { points: [{ x: 8, y: 20 }, null] }), { status: 400 });
    await assert.rejects(send('move', { points: Array(25).fill({ x: 8, y: 20 }) }), { status: 400 });
    await send('move', { points: [{ x: 15, y: 21 }, { x: 12, y: 22 }, { x: 150, y: 24 }] });
    await send('up', { x: 90, y: 25 });
    assert.deepEqual(events, [[1, 20], 'pressed', [15, 21], [12, 22], [99, 24], [90, 25], 'released']);
  } finally {
    await controls.clear();
  }
});

test('manual Taobao verification resumes the same page and is available only to its LAN owner', async t => {
  const previousRoot = process.env.LOCALAPPDATA;
  const previousNetwork = process.env.PRICEPULSE_VERIFICATION_LAN_CIDR;
  const root = mkdtempSync(join(tmpdir(), 'pricepulse-verification-'));
  process.env.LOCALAPPDATA = root;
  process.env.PRICEPULSE_VERIFICATION_LAN_CIDR = '192.168.0.0/24';
  t.after(() => {
    if (previousRoot === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousRoot;
    if (previousNetwork === undefined) delete process.env.PRICEPULSE_VERIFICATION_LAN_CIDR;
    else process.env.PRICEPULSE_VERIFICATION_LAN_CIDR = previousNetwork;
    rmSync(root, { recursive: true, force: true });
  });

  const item = 'https://item.taobao.com/item.htm?id=123456&skuId=4321';
  const request = (address, token, site = 'same-origin') => ({
    socket: { remoteAddress: address },
    get: name => ({
      'x-pricepulse-verification-token': token,
      'x-forwarded-for': '192.168.0.10',
      'sec-fetch-site': site,
    })[name],
  });
  const owner = request('192.168.0.10', 'a'.repeat(32));
  const otherBrowser = request('192.168.0.10', 'b'.repeat(32));
  const publicProxy = request('172.17.0.1', 'a'.repeat(32));
  const crossSite = request('192.168.0.10', 'a'.repeat(32), 'cross-site');
  let verified = false;
  let closed = false;
  let showFrame;
  const page = Object.assign(new EventEmitter(), {
    url: () => item,
    title: async () => verified ? '测试商品' : 'CAPTCHA Verification',
    isClosed: () => closed,
    async route() {},
    goto: t.mock.fn(async () => {}),
    async waitForTimeout() {},
    viewportSize: () => ({ width: 1280, height: 800 }),
    screenshot: async () => Buffer.from('fixture'),
    screencast: {
      start: t.mock.fn(async ({ onFrame }) => {
        showFrame = data => onFrame({ data: Buffer.from(data) });
        showFrame('first');
      }),
      stop: t.mock.fn(async () => {}),
    },
    evaluate: async task => {
      if (String(task).includes('priceReady')) {
        return { title: verified ? '测试商品' : 'CAPTCHA Verification', priceReady: verified };
      }
      return { title: '测试商品', priceTexts: ['123.00'], promoTexts: [], bodySnippet: '' };
    },
    close: t.mock.fn(async () => {
      closed = true;
      page.emit('close');
    }),
  });
  const context = { newPage: t.mock.fn(async () => page) };
  page.context = () => context;
  t.mock.method(sessionModule, 'getTaobaoHeadlessContext', async () => context);

  const controller = new ProductsController();
  await assert.rejects(controller.parse(item, owner), error => error.getResponse().verificationAvailable === true);
  assert.equal(page.close.mock.callCount(), 0);
  const frame = await controller.getVerificationFrame(owner);
  assert.match(frame.screenshot, /^data:image\/jpeg;base64,/);
  assert.equal(frame.frameId, 1);
  showFrame('first');
  assert.deepEqual(await controller.getVerificationFrame(owner, '1'), { state: 'unchanged' });
  showFrame('next');
  assert.equal((await controller.getVerificationFrame(owner, '1')).frameId, 2);
  assert.equal(page.screencast.start.mock.callCount(), 1);
  await assert.rejects(controller.getVerificationFrame(otherBrowser), { status: 410 });
  await assert.rejects(controller.getVerificationFrame(publicProxy), { status: 403 });
  await assert.rejects(controller.getVerificationFrame(crossSite), { status: 403 });
  await assert.rejects(controller.confirmVerification(owner), { status: 400 });
  assert.equal(page.close.mock.callCount(), 0);

  verified = true;
  assert.deepEqual(await controller.getVerificationFrame(owner), { state: 'ready' });
  const product = await controller.confirmVerification(owner);
  assert.equal(product.skuId, '4321');
  assert.equal(controller.list().products[0].finalPrice, 123);
  assert.equal(product.priceHistory.length, 1);
  assert.equal(product.allTimeLow, 123);
  assert.equal(product.allTimeLowAt, product.priceHistory[0].timestamp);
  assert.equal(context.newPage.mock.callCount(), 1);
  assert.equal(page.goto.mock.callCount(), 1);
  assert.equal(page.close.mock.callCount(), 1);
  assert.equal(page.screencast.stop.mock.callCount(), 1);
  await assert.rejects(controller.getVerificationFrame(owner), { status: 410 });

  verified = false;
  closed = false;
  await assert.rejects(controller.parse(item, otherBrowser), error => error.getResponse().verificationAvailable === true);
  assert.deepEqual(await controller.cancelVerification(otherBrowser), { ok: true });
  assert.equal(page.close.mock.callCount(), 2);
  await assert.rejects(controller.getVerificationFrame(otherBrowser), { status: 410 });
});

test('JD frequency controls are reported separately from login', async t => {
  const limitedResponse = new Response('<html></html>');
  Object.defineProperty(limitedResponse, 'url', { value: 'https://trade.m.jd.com/common/limit.html' });
  t.mock.method(globalThis, 'fetch', async () => limitedResponse);
  const page = {
    on() {},
    async route() {},
    async goto() {},
    async waitForTimeout() {},
    url: () => 'https://pc-frequent-pro.pf.jd.com/',
    evaluate: t.mock.fn(async () => ({})),
    close: t.mock.fn(async () => {}),
  };
  t.mock.method(sessionModule, 'getJdHeadlessContext', async () => ({
    newPage: async () => page,
  }));

  await assert.rejects(scrapeAndUpsertProduct('https://item.jd.com/12345678.html'), error => {
    assert.equal(error.getResponse().code, 'JD_RATE_LIMITED');
    assert.match(error.message, /访问频率/);
    assert.doesNotMatch(error.message, /重新扫码/);
    return true;
  });
  assert.equal(page.evaluate.mock.callCount(), 0);
  assert.equal(page.close.mock.callCount(), 1);
});

test('JD uses the observed mobile quote when the page object has a trailing comma and desktop is limited', async t => {
  const identity = { platform: 'jd', id: '12345678', skuId: '12345678', canonicalUrl: 'https://item.jd.com/12345678.html' };
  const itemInfo = JSON.stringify({
    product: { skuId: identity.skuId, skuName: '测试商品' },
    priceFloor: { price: '1??', ext: { jdPrice: '159.00' } },
  }).replace(/}$/, ',\n}');
  t.mock.method(globalThis, 'fetch', async () => new Response(`<script>window._itemInfo = (${itemInfo});\n</script>`));
  const page = {
    on() {},
    async goto() {},
    url: () => 'https://pc-frequent-pro.pf.jd.com/',
    close: t.mock.fn(async () => {}),
  };
  t.mock.method(sessionModule, 'getJdHeadlessContext', async () => ({ newPage: async () => page }));

  const product = await scrapeJdProduct(identity, AbortSignal.timeout(5000));
  assert.equal(product.title, '测试商品');
  assert.equal(product.pagePrice, 159);
  assert.equal(product.finalPrice, null);
  assert.equal(page.close.mock.callCount(), 1);
});

test('JD accepts a labeled mobile quote and leaves masked or unavailable prices pending', async t => {
  const url = 'https://item.m.jd.com/product/12345678.html';
  const visited = [];
  const scrolls = [];
  let mobilePriceText = '¥2,898.00';
  t.mock.method(sessionModule, 'loadPersistedJdSession', () => ({
    cookies: { pt_key: 'fixture-key', pt_pin: 'fixture-pin' },
  }));
  t.mock.method(sessionModule, 'getJdHeadlessContext', async () => ({
    async newPage() {
      let destination;
      return {
        on() {},
        async goto(href) {
          destination = href;
          visited.push(href);
          return { ok: () => true };
        },
        url: () => destination === url ? url : 'https://pc-frequent-pro.pf.jd.com/',
        locator(selector) {
          assert.equal(selector, '#priceSpec #defaultDesc + span');
          return {
            async evaluate(callback) {
              callback({ scrollIntoView: options => scrolls.push(options) });
            },
          };
        },
        async waitForFunction() {},
        async waitForTimeout() {},
        async evaluate(_task, skuId) {
          assert.equal(skuId, '12345678');
          return { label: '国补领后价', text: mobilePriceText, clip: { x: 40, y: 55, width: 84, height: 34 } };
        },
        async close() {},
      };
    },
  }));
  t.mock.method(globalThis, 'fetch', async () => new Response(
    'window._itemInfo = ({"product":{"skuName":"测试商品"},"priceFloor":{"ext":{"jdPrice":"3698"}}});',
  ));
  const identity = { id: '12345678', skuId: '12345678', platform: 'jd', canonicalUrl: url };
  const quote = await scrapeJdProduct(identity, new AbortController().signal);
  assert.equal(quote.pagePrice, 3698);
  assert.equal(quote.finalPrice, 2898);
  assert.equal(quote.subsidyLabel, '国补领后价');
  assert.equal(quote.subsidyPrice, 2898);
  assert.equal(quote.subsidyDiscount, 0);
  assert.deepEqual(visited, [url]);
  assert.deepEqual(scrolls, [{ block: 'center', inline: 'nearest', behavior: 'instant' }]);

  mobilePriceText = '¥????.??';
  const pending = await scrapeJdProduct(identity, new AbortController().signal);
  assert.equal(pending.pagePrice, 3698);
  assert.equal(pending.finalPrice, null);
  assert.equal(pending.subsidyPrice, null);
  assert.deepEqual(visited.slice(1), [url, 'https://item.jd.com/12345678.html']);
});

test('JD keeps the desktop subsidized quote, reference price and applied subsidy distinct', async t => {
  const identity = { platform: 'jd', id: '12345678', skuId: '12345678', canonicalUrl: 'https://item.jd.com/12345678.html' };
  t.mock.method(globalThis, 'fetch', async () => new Response(''));
  t.mock.method(sessionModule, 'getJdHeadlessContext', async () => ({
    newPage: async () => ({
      on() {}, async goto() {}, async close() {}, async waitForTimeout() {},
      url: () => identity.canonicalUrl,
      async evaluate(task) {
        if (!String(task).includes('priceAreaText')) return true;
        return {
          priceAreaText: '', labeledMainPrice: '¥2,898 国补领后价', jpText: '¥2,898',
          pageOriginPriceText: '¥3,698补贴价', pPriceText: '', handPriceElText: '',
          quanAreaText: '已享受：\n国家补贴｜领后减￥500\n满3000减200',
        };
      },
    }),
  }));

  const product = await scrapeJdProduct(identity, AbortSignal.timeout(5000));
  assert.equal(product.pagePrice, 3698);
  assert.equal(product.finalPrice, 2898);
  assert.equal(product.subsidyPrice, 2898);
  assert.equal(product.subsidyDiscount, 500);
  assert.equal(product.couponPrice, null);
  assert.equal(product.couponDiscount, 0);
  assert.deepEqual(product.coupons, ['满3000减200']);
});

test('product collection shares a SKU job and queues one manual request without opening a second browser page', async t => {
  let markStarted;
  let failBrowser;
  const started = new Promise(resolve => { markStarted = resolve; });
  const browser = new Promise((_, reject) => { failBrowser = reject; });
  const launch = t.mock.method(sessionModule, 'getTaobaoHeadlessContext', () => {
    markStarted();
    return browser;
  });
  const launchJd = t.mock.method(sessionModule, 'getJdHeadlessContext', async () => {
    throw new Error('fixture JD browser stopped');
  });
  const fetchedJd = t.mock.method(globalThis, 'fetch', async input => {
    assert.equal(new URL(input).hostname, 'item.m.jd.com');
    return new Response('');
  });
  const item = 'https://item.taobao.com/item.htm?id=123456&skuId=4321';
  const first = scrapeAndUpsertProduct(item + '&pvid=fixture');
  await started;
  const duplicate = scrapeAndUpsertProduct(item + '&utparam=fixture');
  const jd = scrapeAndUpsertProduct('https://item.jd.com/12345678.html');
  const results = Promise.allSettled([first, duplicate, jd]);
  await assert.rejects(scrapeAndUpsertProduct(item.replace('4321', '2345')), { status: 503 });
  assert.equal(launch.mock.callCount(), 1);
  assert.equal(fetchedJd.mock.callCount(), 0);
  failBrowser(new Error('fixture browser stopped'));
  const settled = await results;
  assert.deepEqual(settled.slice(0, 2).map(result => result.reason.status), [400, 400]);
  assert.equal(settled[2].reason.getResponse().code, 'JD_PRICE_UNAVAILABLE');
  assert.equal(fetchedJd.mock.callCount(), 1);
  assert.equal(launchJd.mock.callCount(), 1);

  await assert.rejects(scrapeAndUpsertProduct(item), { status: 400 });
  assert.equal(launch.mock.callCount(), 2);
});
