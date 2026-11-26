const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { readJdDisplayedPrice, resolveJdPrice } = require('./dist/jd-price');
const { saveFeishuConfig } = require('./dist/feishu');
const { scrapeAndUpsertProduct } = require('./dist/products');
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
  assert.deepEqual(readJdDisplayedPrice('京东价 ¥699\n满500减50'), { price: 0, subsidy: false });
  assert.deepEqual(resolveJdPrice({ displayed: 699, quotedOffer: 659, selling: 649, original: 799 }), {
    finalPrice: 699, pagePrice: 799,
  });
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
  assert.notEqual(settled[2].reason?.status, 503);
  assert.equal(fetchedJd.mock.callCount(), 1);
  assert.equal(launchJd.mock.callCount(), 1);

  await assert.rejects(scrapeAndUpsertProduct(item), { status: 400 });
  assert.equal(launch.mock.callCount(), 2);
});
