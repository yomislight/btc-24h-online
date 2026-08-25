type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
};

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentChange(current: number, previous: number | undefined) {
  return previous ? ((current - previous) / previous) * 100 : 0;
}

function rsi(closes: number[], period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const start = closes.length - period;
  for (let index = start; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const relativeStrength = (gains / period) / (losses / period);
  return 100 - (100 / (1 + relativeStrength));
}

function atr(candles: Candle[], period = 14) {
  const rows = candles.slice(-(period + 1));
  if (rows.length < 2) return 0;
  const ranges = rows.slice(1).map((candle, index) => {
    const previousClose = rows[index].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  return average(ranges);
}

type IntervalKey = '1h' | '1d' | '1M';
const intervalConfig: Record<IntervalKey, { limit: number; granularity?: number; unit: 'hour' | 'day' | 'month' }> = {
  '1h': { limit: 240, granularity: 3600, unit: 'hour' },
  '1d': { limit: 220, granularity: 86400, unit: 'day' },
  '1M': { limit: 180, unit: 'month' },
};

async function getBinanceCandles(interval: IntervalKey): Promise<Candle[]> {
  const config = intervalConfig[interval];
  const response = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${config.limit}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Binance ${response.status}`);
  const rows = await response.json() as Array<Array<number | string>>;
  return rows.map((row) => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[5]), quoteVolume: Number(row[7]),
  }));
}

async function getCoinbaseCandles(interval: IntervalKey): Promise<Candle[]> {
  const config = intervalConfig[interval];
  if (!config.granularity) throw new Error('Coinbase monthly candles unavailable');
  const response = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${config.granularity}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Coinbase ${response.status}`);
  const rows = await response.json() as number[][];
  return rows.map((row) => ({
    time: row[0] * 1000, low: row[1], high: row[2], open: row[3], close: row[4], volume: row[5], quoteVolume: row[5] * row[4],
  })).sort((a, b) => a.time - b.time).slice(-config.limit);
}

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get('interval');
  const interval: IntervalKey = requested === '1h' || requested === '1M' ? requested : '1d';
  const config = intervalConfig[interval];
  let candles: Candle[];
  let source = 'Binance Spot';
  try {
    candles = await getBinanceCandles(interval);
  } catch {
    candles = await getCoinbaseCandles(interval);
    source = 'Coinbase Exchange';
  }

  if (candles.length < 31) return Response.json({ status: 'offline', source }, { status: 503 });
  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1)!;
  const last30 = candles.slice(-30);
  const completedVolumes = candles.slice(-21, -1).map((candle) => candle.volume);
  const metrics = {
    dayChange: percentChange(latest.close, closes.at(-2)),
    sevenDayChange: percentChange(latest.close, closes.at(-8)),
    thirtyDayChange: percentChange(latest.close, closes.at(-31)),
    sma7: average(closes.slice(-7)),
    sma30: average(closes.slice(-30)),
    sma200: average(closes.slice(-200)),
    rsi14: rsi(closes),
    atr14: atr(candles),
    high30: Math.max(...last30.map((candle) => candle.high)),
    low30: Math.min(...last30.map((candle) => candle.low)),
    todayVolume: latest.volume,
    averageVolume20: average(completedVolumes),
    volumeRatio: completedVolumes.length ? latest.volume / average(completedVolumes) : 0,
  };

  return Response.json(
    { status: 'live', source, interval, unit: config.unit, updatedAt: Date.now(), candles, metrics },
    { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' } },
  );
}
