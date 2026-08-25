const FARSIDE_URL = 'https://farside.co.uk/bitcoin-etf-flow-all-data/';
const FARSIDE_READER_URL = 'https://r.jina.ai/https://farside.co.uk/bitcoin-etf-flow-all-data/';
const ETF_TICKERS = ['IBIT', 'FBTC', 'BITB', 'ARKB', 'BTCO', 'EZBC', 'BRRR', 'HODL', 'BTCW', 'MSBT', 'GBTC', 'BTC'];

type EtfDay = { date: string; total: number; funds: Record<string, number | null> };

const fallbackEtf: EtfDay[] = [
  { date: '18 Aug 2026', total: 189.3, funds: {} },
  { date: '19 Aug 2026', total: 517.2, funds: {} },
  { date: '20 Aug 2026', total: 606.3, funds: {} },
  { date: '21 Aug 2026', total: 307.5, funds: {} },
  { date: '24 Aug 2026', total: 128.7, funds: { IBIT: null, FBTC: 104.6, BITB: 3.0, ARKB: 0, BTCO: 0, EZBC: 0, BRRR: 0, HODL: 3.3, BTCW: 0, MSBT: 1.4, GBTC: 0, BTC: 16.4 } },
];

function parseFlow(value: string): number | null {
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized || normalized === '-') return null;
  if (normalized.startsWith('(') && normalized.endsWith(')')) return -Number(normalized.slice(1, -1));
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFarside(markdown: string): EtfDay[] {
  const rows: EtfDay[] = [];
  for (const line of markdown.split('\n')) {
    if (!/^\|\s*\d{2}\s+[A-Z][a-z]{2}\s+\d{4}\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 14) continue;
    const funds = Object.fromEntries(ETF_TICKERS.map((ticker, index) => [ticker, parseFlow(cells[index + 1])]));
    const total = parseFlow(cells[13]);
    if (total !== null) rows.push({ date: cells[0], total, funds });
  }
  if (rows.length) return rows;

  const tokens = markdown.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!/^\d{2}\s+[A-Z][a-z]{2}\s+\d{4}$/.test(tokens[index])) continue;
    const cells = tokens.slice(index + 1, index + 14);
    if (cells.length < 13 || cells.some((cell) => !/^(?:-|\(?[\d,.]+\)?)$/.test(cell))) continue;
    const funds = Object.fromEntries(ETF_TICKERS.map((ticker, fundIndex) => [ticker, parseFlow(cells[fundIndex])]));
    const total = parseFlow(cells[12]);
    if (total !== null) rows.push({ date: tokens[index], total, funds });
  }
  return rows;
}

async function getEtfData() {
  try {
    const response = await fetch(FARSIDE_READER_URL, { headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Farside reader ${response.status}`);
    const rows = parseFarside(await response.text());
    if (rows.length < 5) throw new Error('Farside table incomplete');
    const recent = rows.slice(-7);
    return {
      status: 'live', source: 'Farside Investors', sourceUrl: FARSIDE_URL, via: 'Jina Reader',
      latest: recent.at(-1), recent, fiveDayTotal: recent.slice(-5).reduce((sum, row) => sum + row.total, 0),
    };
  } catch (error) {
    return {
      status: 'snapshot', source: 'Farside Investors', sourceUrl: FARSIDE_URL, via: null,
      latest: fallbackEtf.at(-1), recent: fallbackEtf, fiveDayTotal: fallbackEtf.reduce((sum, row) => sum + row.total, 0),
      detail: error instanceof Error ? error.message : 'Farside sync failed',
    };
  }
}

async function getDerivativesData() {
  try {
    const [premiumResponse, oiResponse, ratioResponse] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { signal: AbortSignal.timeout(8000) }),
      fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT', { signal: AbortSignal.timeout(8000) }),
      fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1', { signal: AbortSignal.timeout(8000) }),
    ]);
    if (!premiumResponse.ok || !oiResponse.ok || !ratioResponse.ok) throw new Error('Binance futures unavailable');
    const [premium, oi, ratioRows] = await Promise.all([premiumResponse.json(), oiResponse.json(), ratioResponse.json()]);
    const markPrice = Number(premium.markPrice);
    const openInterestBtc = Number(oi.openInterest);
    return {
      status: 'live', source: 'Binance Futures', markPrice, fundingRate: Number(premium.lastFundingRate) * 100,
      nextFundingTime: Number(premium.nextFundingTime), openInterestBtc, openInterestUsd: openInterestBtc * markPrice,
      longShortRatio: Number(ratioRows?.[0]?.longShortRatio), updatedAt: Number(premium.time),
    };
  } catch {
    return { status: 'offline', source: 'Binance Futures' };
  }
}

async function getWhaleData() {
  try {
    const response = await fetch('https://mempool.space/api/mempool/recent', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('mempool.space unavailable');
    const rows = await response.json() as Array<{ txid: string; value: number; fee: number; vsize: number }>;
    const transfers = rows.map((row) => ({ txid: row.txid, btc: row.value / 100_000_000, feeRate: row.vsize ? row.fee / row.vsize : 0 })).sort((a, b) => b.btc - a.btc);
    return {
      status: 'live', source: 'mempool.space', thresholdBtc: 100, sampleSize: transfers.length,
      largeCount: transfers.filter((row) => row.btc >= 100).length, largest: transfers[0] ?? null, checkedAt: Date.now(),
    };
  } catch {
    return { status: 'offline', source: 'mempool.space', thresholdBtc: 100, sampleSize: 0, largeCount: 0, largest: null };
  }
}

export async function GET() {
  const [etf, derivatives, whale] = await Promise.all([getEtfData(), getDerivativesData(), getWhaleData()]);
  return Response.json(
    { etf, derivatives, whale, collectedAt: Date.now() },
    { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' } },
  );
}
