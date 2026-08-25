type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
};

type IntervalKey = '1h' | '1d' | '1M';
type ExchangeSeries = { name: string; marketType: 'spot' | 'perp'; candles: Candle[] };

const intervalConfig: Record<IntervalKey, { limit: number; granularity?: number; milliseconds: number; unit: 'hour' | 'day' | 'month' }> = {
  '1h': { limit: 240, granularity: 3600, milliseconds: 3_600_000, unit: 'hour' },
  '1d': { limit: 220, granularity: 86400, milliseconds: 86_400_000, unit: 'day' },
  '1M': { limit: 180, milliseconds: 31 * 86_400_000, unit: 'month' },
};

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

function bucketTime(time: number, interval: IntervalKey) {
  const date = new Date(time);
  if (interval === '1h') return Math.floor(time / 3_600_000) * 3_600_000;
  if (interval === '1d') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

async function getBinanceCandles(interval: IntervalKey): Promise<ExchangeSeries> {
  const config = intervalConfig[interval];
  const response = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${config.limit}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Binance ${response.status}`);
  const rows = await response.json() as Array<Array<number | string>>;
  return {
    name: 'Binance', marketType: 'spot', candles: rows.map((row) => ({
      time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      volume: Number(row[5]), quoteVolume: Number(row[7]),
    })),
  };
}

async function getCoinbaseCandles(interval: IntervalKey): Promise<ExchangeSeries> {
  const config = intervalConfig[interval];
  if (!config.granularity) throw new Error('Coinbase不提供月K');
  const response = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${config.granularity}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Coinbase ${response.status}`);
  const rows = await response.json() as number[][];
  return {
    name: 'Coinbase', marketType: 'spot', candles: rows.map((row) => ({
      time: row[0] * 1000, low: row[1], high: row[2], open: row[3], close: row[4], volume: row[5], quoteVolume: row[5] * row[4],
    })).sort((a, b) => a.time - b.time).slice(-config.limit),
  };
}

async function getOkxCandles(interval: IntervalKey): Promise<ExchangeSeries> {
  const bar = interval === '1h' ? '1H' : interval === '1d' ? '1Dutc' : '1Mutc';
  const limit = Math.min(300, intervalConfig[interval].limit);
  const response = await fetch(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${bar}&limit=${limit}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`OKX ${response.status}`);
  const payload = await response.json() as { code: string; data: string[][] };
  if (payload.code !== '0') throw new Error(`OKX code ${payload.code}`);
  return {
    name: 'OKX', marketType: 'spot', candles: payload.data.map((row) => ({
      time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      volume: Number(row[5]), quoteVolume: Number(row[7]),
    })).sort((a, b) => a.time - b.time),
  };
}

async function getBybitCandles(interval: IntervalKey): Promise<ExchangeSeries> {
  const bybitInterval = interval === '1h' ? '60' : interval === '1d' ? 'D' : 'M';
  const response = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=${bybitInterval}&limit=${intervalConfig[interval].limit}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Bybit ${response.status}`);
  const payload = await response.json() as { retCode: number; result: { list: string[][] } };
  if (payload.retCode !== 0) throw new Error(`Bybit code ${payload.retCode}`);
  return {
    name: 'Bybit', marketType: 'spot', candles: payload.result.list.map((row) => ({
      time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      volume: Number(row[5]), quoteVolume: Number(row[6]),
    })).sort((a, b) => a.time - b.time),
  };
}

async function getHyperliquidCandles(interval: IntervalKey): Promise<ExchangeSeries> {
  const config = intervalConfig[interval];
  const endTime = Date.now();
  const startTime = endTime - config.milliseconds * (config.limit + 3);
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'BTC', interval, startTime, endTime } }),
  });
  if (!response.ok) throw new Error(`Hyperliquid ${response.status}`);
  const rows = await response.json() as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
  return {
    name: 'Hyperliquid', marketType: 'perp', candles: rows.map((row) => ({
      time: row.t, open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c),
      volume: Number(row.v), quoteVolume: Number(row.v) * Number(row.c),
    })).sort((a, b) => a.time - b.time).slice(-config.limit),
  };
}

function aggregateCandles(series: ExchangeSeries[], interval: IntervalKey) {
  const buckets = new Map<number, Candle[]>();
  for (const exchange of series) {
    for (const candle of exchange.candles) {
      const key = bucketTime(candle.time, interval);
      const rows = buckets.get(key) ?? [];
      rows.push({ ...candle, time: key });
      buckets.set(key, rows);
    }
  }
  return [...buckets.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort(([a], [b]) => a - b)
    .map(([time, rows]) => ({
      time,
      open: median(rows.map((row) => row.open)),
      high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)),
      close: median(rows.map((row) => row.close)),
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
      quoteVolume: rows.reduce((sum, row) => sum + row.quoteVolume, 0),
    }));
}

function buildConsensus(series: ExchangeSeries[], interval: IntervalKey) {
  const exchanges = series.map((exchange) => {
    const latest = exchange.candles.at(-1)!;
    const completedVolumes = exchange.candles.slice(-21, -1).map((row) => row.volume);
    const volumeAverage = average(completedVolumes);
    const change = percentChange(latest.close, latest.open);
    const start = bucketTime(latest.time, interval);
    const end = interval === '1h'
      ? start + 3_600_000
      : interval === '1d'
        ? start + 86_400_000
        : Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1);
    const progress = Math.max(.08, Math.min(1, (Date.now() - start) / (end - start)));
    return {
      name: exchange.name,
      marketType: exchange.marketType,
      close: latest.close,
      change,
      volumeRatio: volumeAverage ? (latest.volume / volumeAverage) / progress : 0,
      direction: change > .05 ? 'up' : change < -.05 ? 'down' : 'flat',
    };
  });
  const closes = exchanges.map((exchange) => exchange.close);
  const center = median(closes);
  return {
    requested: 5,
    live: exchanges.length,
    bullish: exchanges.filter((exchange) => exchange.direction === 'up').length,
    bearish: exchanges.filter((exchange) => exchange.direction === 'down').length,
    neutral: exchanges.filter((exchange) => exchange.direction === 'flat').length,
    volumeConfirmCount: exchanges.filter((exchange) => exchange.volumeRatio >= 1).length,
    spreadPct: center ? ((Math.max(...closes) - Math.min(...closes)) / center) * 100 : 0,
    exchanges,
  };
}

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get('interval');
  const interval: IntervalKey = requested === '1h' || requested === '1M' ? requested : '1d';
  const config = intervalConfig[interval];
  const exchangeNames = ['Binance', 'Coinbase', 'OKX', 'Bybit', 'Hyperliquid'];
  const settled = await Promise.allSettled([
    getBinanceCandles(interval), getCoinbaseCandles(interval), getOkxCandles(interval), getBybitCandles(interval), getHyperliquidCandles(interval),
  ]);
  const series = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const failedSources = exchangeNames.filter((name) => !series.some((exchange) => exchange.name === name));
  const candles = aggregateCandles(series, interval).slice(-config.limit);
  const source = `${series.length}/5 交易所综合K线`;

  if (series.length < 2 || candles.length < 31) {
    return Response.json({ status: 'offline', source, failedSources }, { status: 503 });
  }

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
    {
      status: 'live', source, sources: series.map((exchange) => exchange.name), failedSources,
      interval, unit: config.unit, updatedAt: Date.now(), candles, metrics, consensus: buildConsensus(series, interval),
    },
    { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' } },
  );
}
