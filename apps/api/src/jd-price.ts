const subsidyLabel = '国补领后价|补贴领后价|政府补贴价|国补价';
const handLabel = '预估到手价|PLUS到手价|到手价|券后价|折后价';
const amount = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)(?![\\d.,])';

function findLabeledPrice(text: string, label: string): number {
  // Keep the rows separate so a price on the previous row cannot bind to this label.
  const patterns = [
    new RegExp(`(?:^|[|｜])\\s*[¥￥]\\s*${amount}\\s*(?:${label})`),
    new RegExp(`(?:${label})\\s*[:：]?\\s*[¥￥]?\\s*${amount}`),
  ];
  for (const row of text.split(/\r?\n/)) {
    for (const pattern of patterns) {
      const match = row.match(pattern);
      if (match) return Number(match[1].replace(/,/g, ''));
    }
  }
  return 0;
}

export function readJdDisplayedPrice(text: string): { price: number; subsidy: boolean } {
  const subsidy = findLabeledPrice(text, subsidyLabel);
  return subsidy > 0
    ? { price: subsidy, subsidy: true }
    : { price: findLabeledPrice(text, handLabel), subsidy: false };
}

export function resolveJdPrice(
  prices: { displayed: number; quotedOffer: number; selling: number; original: number },
) {
  const finalPrice = prices.displayed || prices.quotedOffer || prices.selling || prices.original;
  return {
    finalPrice,
    pagePrice: Math.max(prices.original, prices.selling, finalPrice),
  };
}
