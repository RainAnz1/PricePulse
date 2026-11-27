import { execFile } from 'node:child_process';

const subsidyLabel = '国补领后价|补贴领后价|政府补贴价|国补价';
const handLabel = '预估到手价|PLUS到手价|到手价|券后价|折后价';
const exactSubsidyLabel = new RegExp(`^(?:${subsidyLabel})$`);
const exactHandLabel = new RegExp(`^(?:${handLabel})$`);
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

export function jdOfferLabelKind(label: string): 'subsidy' | 'offer' | null {
  if (exactSubsidyLabel.test(label)) return 'subsidy';
  return exactHandLabel.test(label) ? 'offer' : null;
}

export function jdVisiblePriceShape(text: string): string | null {
  const shape = text.trim().replace(/^[¥￥]\s*/, '').replace(/[\d\uE000-\uF8FF]/g, '#');
  if (!/^(?:#{1,7}|#{1,3}(?:,#{3}){1,2})(?:\.#{1,2})?$/.test(shape)) return null;
  return shape.replace(/,/g, '');
}

async function recognizePrice(image: Buffer, mode: '7' | '8', signal: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile('tesseract', [
      'stdin', 'stdout', '-l', 'eng', '--psm', mode, '-c', 'tessedit_char_whitelist=0123456789.,', 'tsv',
    ], { timeout: 2000, maxBuffer: 16384, signal }, (error, output) => {
      if (error) return resolve(null);
      const words = output.split(/\r?\n/).map(line => line.split('\t')).filter(row => row[0] === '5' && row[11]);
      if (words.length !== 1 || !(Number(words[0][10]) >= 85)) return resolve(null);
      resolve(words[0][11]);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(image);
  });
}

export async function readJdPriceImage(image: Buffer, shape: string, signal: AbortSignal): Promise<number | null> {
  const line = await recognizePrice(image, '7', signal);
  if (line === null || jdVisiblePriceShape(line) !== shape) return null;
  const word = await recognizePrice(image, '8', signal);
  if (line !== word || !/^\d{1,7}(?:\.\d{1,2})?$/.test(line.replace(/,/g, ''))) return null;
  return Number(line.replace(/,/g, '')) || null;
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
