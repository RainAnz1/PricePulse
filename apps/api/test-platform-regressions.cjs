const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { readJdDisplayedPrice, resolveJdPrice } = require('./dist/jd-price');
const { saveFeishuConfig } = require('./dist/feishu');
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
