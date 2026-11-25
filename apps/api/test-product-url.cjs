const assert = require('node:assert/strict');
const { parseProductUrl } = require('./dist/product-url');
const jd = parseProductUrl('https://item.jd.com/100413060348.html?ref=x');
assert.equal(jd.skuId, '100413060348');
assert.equal(jd.canonicalUrl, 'https://item.jd.com/100413060348.html');
const taobao = parseProductUrl('https://detail.tmall.com/item.htm?id=1005933865145&skuId=6165077234674&ref=x');
assert.equal(taobao.skuId, '6165077234674');
assert.equal(taobao.canonicalUrl, 'https://detail.tmall.com/item.htm?id=1005933865145&skuId=6165077234674');
assert.throws(() => parseProductUrl('https://detail.tmall.com/item.htm?id=0'));
assert.throws(() => parseProductUrl('https://item.jd.com.evil.test/100413060348.html'));
const invalidSku = parseProductUrl('https://detail.tmall.com/item.htm?id=123&skuId=abc');
assert.equal(invalidSku.skuId, null);
assert.equal(invalidSku.canonicalUrl, 'https://detail.tmall.com/item.htm?id=123');
console.log('商品链接和规格识别检查通过');

