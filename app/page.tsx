'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type FeedStatus = 'connecting' | 'live' | 'offline';
type ExchangeId = 'coinbase' | 'binance' | 'okx' | 'bybit' | 'hyperliquid';
type CandleInterval = '1h' | '1d' | '1M';
type MarketData = { price: number | null; change: number | null; high: number | null; low: number | null; volume: number | null; status: FeedStatus; updatedAt: number | null };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number };
type DailyData = {
  status: 'live'; source: string; interval: CandleInterval; unit: 'hour' | 'day' | 'month'; updatedAt: number; candles: Candle[];
  metrics: { dayChange: number; sevenDayChange: number; thirtyDayChange: number; sma7: number; sma30: number; sma200: number; rsi14: number; atr14: number; high30: number; low30: number; todayVolume: number; averageVolume20: number; volumeRatio: number };
};
type IntelligenceData = {
  etf: { status: 'live' | 'snapshot'; source: string; sourceUrl: string; fiveDayTotal: number; latest: { date: string; total: number; funds: Record<string, number | null> } | null; recent: Array<{ date: string; total: number; funds: Record<string, number | null> }> };
  derivatives: { status: 'live' | 'offline'; source: string; fundingRate?: number; nextFundingTime?: number; openInterestBtc?: number; openInterestUsd?: number; longShortRatio?: number; updatedAt?: number };
  whale: { status: 'live' | 'offline'; source: string; thresholdBtc: number; sampleSize: number; largeCount: number; largest: { txid: string; btc: number; feeRate: number } | null; checkedAt?: number };
  collectedAt: number;
};
type Advice = { score: number; label: string; bias: string; detail: string; points: Array<{ text: string; positive: boolean }>; allocation: string; invalidation: number | null };
type ForecastScenario = 'base' | 'bull' | 'bear';
type ForecastCandle = Candle & {
  confidence: number;
  summary: string;
  drivers: Array<{ label: string; detail: string; impact: 'up' | 'down' | 'neutral' }>;
  confirm: string;
  invalidation: string;
};
type Forecast = {
  scenario: ForecastScenario; label: string; probability: number; direction: string; expectedReturn: number;
  targetLow: number; targetHigh: number; invalidation: number; virtualCandles: ForecastCandle[];
  reasons: Array<{ label: string; value: string; tone: 'positive' | 'negative' | 'neutral' }>;
};

const emptyMarket = (): MarketData => ({ price: null, change: null, high: null, low: null, volume: null, status: 'connecting', updatedAt: null });
const exchanges: Array<{ id: ExchangeId; name: string; pair: string; mark: string; color: string }> = [
  { id: 'coinbase', name: 'Coinbase', pair: 'BTC / USD', mark: 'C', color: 'coinbase' },
  { id: 'binance', name: 'Binance', pair: 'BTC / USDT', mark: 'B', color: 'binance' },
  { id: 'okx', name: 'OKX', pair: 'BTC / USDT', mark: 'O', color: 'okx' },
  { id: 'bybit', name: 'Bybit', pair: 'BTC / USDT', mark: 'Y', color: 'bybit' },
  { id: 'hyperliquid', name: 'Hyperliquid', pair: 'BTC / USD PERP', mark: 'H', color: 'hyperliquid' },
];

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '连接中';
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function formatVolume(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} BTC`;
}
function compactUsd(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value);
}
function flowLabel(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
}
function signed(value: number | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}
function ageLabel(updatedAt: number | null, now: number) {
  if (!updatedAt) return '等待更新';
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  return seconds < 2 ? '刚刚' : `${seconds}秒前`;
}

function intervalName(interval: CandleInterval) {
  return interval === '1h' ? '小时' : interval === '1M' ? '月' : '日';
}

function formatCandleTime(time: number, interval: CandleInterval) {
  const date = new Date(time);
  if (interval === '1h') return `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} JST`;
  if (interval === '1M') return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' });
  return `${date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })} JST`;
}

function addCandleTime(time: number, steps: number, interval: CandleInterval) {
  if (interval === '1h') return time + steps * 3_600_000;
  if (interval === '1d') return time + steps * 86_400_000;
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + steps, 1);
}

function buildKlineReason(daily: DailyData | null, intel: IntelligenceData | null, price: number | null, direction?: string) {
  if (!daily || !price) return '正在汇总趋势、动量、资金流和成交量，数据完整后会显示判断原因。';
  const m = daily.metrics;
  const unit = intervalName(daily.interval);
  const trend = price > m.sma30 ? `价格站在30${unit}均线 ${formatPrice(m.sma30)} 上方，主要趋势仍偏强` : `价格跌到30${unit}均线 ${formatPrice(m.sma30)} 下方，趋势转弱`;
  const momentum = m.rsi14 > 75 ? `但 RSI ${m.rsi14.toFixed(0)} 已明显过热，继续追涨容易出现回踩` : m.rsi14 < 35 ? `RSI ${m.rsi14.toFixed(0)} 接近超卖，存在技术反弹条件` : `RSI ${m.rsi14.toFixed(0)} 位于中性区，动量没有极端拥挤`;
  const flow = (intel?.etf.fiveDayTotal ?? 0) > 0 ? `ETF近5日净流入 ${flowLabel(intel?.etf.fiveDayTotal)}，中期买盘仍有支撑` : `ETF近5日为净流出，机构资金暂未形成支撑`;
  const volume = m.volumeRatio < .8 ? `当前量能只有20日均量的 ${m.volumeRatio.toFixed(2)} 倍，突破确认不足` : `当前量能达到20日均量的 ${m.volumeRatio.toFixed(2)} 倍，价格变化有成交支持`;
  return `${trend}；${flow}；${momentum}；${volume}。因此模型把后续K线判断为“${direction ?? '震荡等待确认'}”。`;
}

function buildAdvice(mode: 'short' | 'long', daily: DailyData | null, intel: IntelligenceData | null, livePrice: number | null): Advice {
  if (!daily) return { score: 50, label: '等待数据', bias: '计算中', detail: '日线、ETF与衍生品尚未同步', points: [{ text: '正在读取真实市场数据', positive: true }], allocation: '暂不操作', invalidation: null };
  const m = daily.metrics;
  const unit = intervalName(daily.interval);
  const price = livePrice ?? daily.candles.at(-1)?.close ?? 0;
  const etf = intel?.etf.fiveDayTotal;
  const funding = intel?.derivatives.fundingRate;
  let score = 50;
  const points: Array<{ text: string; positive: boolean }> = [];

  if (mode === 'long') {
    if (price > m.sma200) { score += 14; points.push({ text: `价格在200${unit}均线上方（${formatPrice(m.sma200)}）`, positive: true }); }
    else { score -= 16; points.push({ text: `价格跌破200${unit}均线（${formatPrice(m.sma200)}）`, positive: false }); }
    if (m.sma7 > m.sma30) { score += 10; points.push({ text: `7${unit}均线高于30${unit}均线`, positive: true }); }
    else { score -= 10; points.push({ text: `7${unit}均线低于30${unit}均线`, positive: false }); }
    if (m.thirtyDayChange > 0) score += 7; else score -= 7;
    if (m.rsi14 > 75) { score -= 12; points.push({ text: `RSI ${m.rsi14.toFixed(0)}，不适合一次性追买`, positive: false }); }
    if (m.sevenDayChange > 20) score -= 8;
  } else {
    if (m.sevenDayChange > 0) { score += 10; points.push({ text: `近7${unit}上涨 ${m.sevenDayChange.toFixed(1)}%`, positive: true }); }
    else { score -= 10; points.push({ text: `近7${unit}下跌 ${Math.abs(m.sevenDayChange).toFixed(1)}%`, positive: false }); }
    if (price > m.sma30) score += 8; else score -= 8;
    if (m.rsi14 > 72) { score -= 13; points.push({ text: `RSI ${m.rsi14.toFixed(0)}，短线偏热`, positive: false }); }
    else if (m.rsi14 < 32) { score += 9; points.push({ text: `RSI ${m.rsi14.toFixed(0)}，接近超卖区`, positive: true }); }
    else points.push({ text: `RSI ${m.rsi14.toFixed(0)}，未过热`, positive: true });
  }
  if (etf != null) {
    if (etf > 500) { score += 10; points.push({ text: `ETF近5日净流入 ${flowLabel(etf)}`, positive: true }); }
    else if (etf < 0) { score -= 10; points.push({ text: `ETF近5日净流出 ${flowLabel(etf)}`, positive: false }); }
    else points.push({ text: `ETF近5日小幅净流入 ${flowLabel(etf)}`, positive: true });
  }
  if (funding != null && funding > 0.03) { score -= 8; points.push({ text: `资金费率 ${funding.toFixed(4)}%，多头拥挤`, positive: false }); }
  else if (funding != null && points.length < 4) points.push({ text: `资金费率 ${funding.toFixed(4)}%，杠杆未过热`, positive: true });
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 72 ? '分批买入' : score >= 58 ? '继续持有' : score >= 43 ? '等待确认' : score >= 28 ? '逐步减仓' : '降低风险';
  const allocation = score >= 72 ? (mode === 'long' ? '每次 10–15%' : '试仓 10%') : score >= 58 ? '持仓不追高' : score >= 43 ? '暂停加仓' : '减仓 20–30%';
  const invalidation = price ? (score >= 58 ? Math.max(m.sma30, price - m.atr14 * 2) : Math.min(m.sma30, price + m.atr14)) : null;
  return { score, label, bias: score >= 58 ? '偏多' : score < 43 ? '偏空' : '中性', detail: mode === 'long' ? `30${unit} ${signed(m.thirtyDayChange)} · RSI ${m.rsi14.toFixed(0)}` : `7${unit} ${signed(m.sevenDayChange)} · 量比 ${m.volumeRatio.toFixed(2)}`, points: points.slice(0, 4), allocation, invalidation };
}

function seededValue(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function buildForecasts(daily: DailyData | null, intel: IntelligenceData | null, livePrice: number | null, horizon: number): Forecast[] {
  if (!daily || !daily.candles.length) return [];
  const m = daily.metrics;
  const last = daily.candles.at(-1)!;
  const price = livePrice ?? last.close;
  let trend = 0;
  if (price > m.sma200) trend += .9; else trend -= .9;
  if (m.sma7 > m.sma30) trend += .7; else trend -= .7;
  if (m.thirtyDayChange > 0) trend += .35; else trend -= .35;
  if ((intel?.etf.fiveDayTotal ?? 0) > 0) trend += .5; else if ((intel?.etf.fiveDayTotal ?? 0) < 0) trend -= .5;
  if (m.rsi14 > 75) trend -= 1;
  if (m.rsi14 < 30) trend += .7;
  if (m.sevenDayChange > 20) trend -= .45;
  if ((intel?.derivatives.fundingRate ?? 0) > .03) trend -= .4;

  const bullProbability = Math.round(Math.max(15, Math.min(42, 26 + trend * 7)));
  const bearProbability = Math.round(Math.max(15, Math.min(42, 25 - trend * 6)));
  const baseProbability = 100 - bullProbability - bearProbability;
  const atrPct = Math.max(.012, Math.min(.06, m.atr14 / price));
  const seedStep = daily.interval === '1h' ? 3_600_000 : 86_400_000;
  const configs: Array<{ scenario: ForecastScenario; label: string; probability: number; drift: number; direction: string }> = [
    { scenario: 'base', label: '基准震荡', probability: baseProbability, drift: Math.max(-.003, Math.min(.004, trend * .0012)), direction: trend >= 0 ? '高位震荡偏强' : '震荡偏弱' },
    { scenario: 'bull', label: '向上突破', probability: bullProbability, drift: atrPct * .24, direction: '突破后延续上行' },
    { scenario: 'bear', label: '回撤修正', probability: bearProbability, drift: -atrPct * .27, direction: '冲高后回撤' },
  ];

  return configs.map((config, scenarioIndex) => {
    let previous = price;
    let previousWasUp = last.close >= last.open;
    const virtualCandles = Array.from({ length: horizon }, (_, index) => {
      const seed = last.time / seedStep + scenarioIndex * 71 + index * 13;
      const noise = (seededValue(seed) - .5) * m.atr14 * .34;
      const pulse = Math.sin((index + 1) * 1.8 + scenarioIndex) * m.atr14 * .08;
      const open = previous + (seededValue(seed + 3) - .5) * m.atr14 * .10;
      const close = Math.max(1, previous * (1 + config.drift) + noise + pulse);
      const wick = m.atr14 * (.16 + seededValue(seed + 7) * .16);
      const volume = m.averageVolume20 * (.72 + seededValue(seed + 17) * .45);
      const change = (close - open) / open * 100;
      const up = close >= open;
      const trendPositive = price > m.sma30 && m.sma7 > m.sma30;
      const etfPositive = (intel?.etf.fiveDayTotal ?? 0) > 0;
      const volumeStrong = volume >= m.averageVolume20;
      const rsiHot = m.rsi14 > 72;
      const volumeRatio = volume / m.averageVolume20;
      const moveSize = Math.abs(change) < .45 ? '小' : Math.abs(change) < 1 ? '普通' : '较强';
      const drivers: ForecastCandle['drivers'] = [
        { label: up ? '我为什么偏向涨' : '我为什么偏向跌', detail: up ? (trendPositive ? `价格还在30${intervalName(daily.interval)}均线上面，7${intervalName(daily.interval)}均线也更高，短线趋势还没有走坏。` : `前一根回落后没有继续破低，我先按技术反弹看这一根。`) : (previousWasUp && rsiHot ? `前一根刚涨完，RSI已经到 ${m.rsi14.toFixed(0)}，短线获利盘容易先卖一部分。` : `价格往上推得不顺，买盘没有把上一根高点拿下来，容易先回踩。`), impact: up ? 'up' : 'down' },
        { label: up ? '为什么只看小涨' : '这是不是转空', detail: up ? (rsiHot ? `这段已经涨得很快，RSI ${m.rsi14.toFixed(0)} 明显偏高，所以我只看${moveSize}阳线，不看连续大涨。` : `RSI ${m.rsi14.toFixed(0)} 还没有过热，上涨还有空间，但仍要看成交量。`) : (trendPositive ? `目前价格仍在30${intervalName(daily.interval)}均线上方，所以我把它看成回踩，不是趋势已经转空。` : `均线已经转弱，这次下跌需要更谨慎，不能只当普通回踩。`), impact: up ? (rsiHot ? 'down' : 'up') : (trendPositive ? 'neutral' : 'down') },
        { label: '外部资金有没有接', detail: etfPositive ? `ETF近5日合计净流入 ${flowLabel(intel?.etf.fiveDayTotal)}，说明回落时仍可能有人接盘。` : `ETF近5日没有净流入，市场少了一块稳定买盘，反弹更容易停住。`, impact: etfPositive ? 'up' : 'down' },
        { label: '成交量够不够', detail: `这根预计只有20${intervalName(daily.interval)}平均成交量的 ${volumeRatio.toFixed(2)} 倍。${volumeStrong ? `量够，${up ? '上涨' : '下跌'}更容易延续。` : `量不够，所以我不认为它能走出很大的${up ? '涨幅' : '跌幅'}。`}`, impact: volumeStrong ? (up ? 'up' : 'down') : 'neutral' },
      ];
      const summary = up
        ? `我把这根看成${moveSize}阳线。${trendPositive ? '趋势还在向上' : '前一根回落后有反弹需要'}${etfPositive ? '，ETF资金也还在流入' : ''}；${rsiHot ? '但现在涨得偏热' : '动量还不算拥挤'}，成交量又只有均量的 ${volumeRatio.toFixed(2)} 倍，所以只看小幅走高。`
        : `我把这根看成${moveSize}阴线。${previousWasUp ? '前一根上涨后容易出现获利回吐' : '上方买盘没有继续跟进'}，${rsiHot ? `RSI ${m.rsi14.toFixed(0)} 也说明短线偏热` : '短线动量正在减弱'}；${trendPositive || etfPositive ? '不过趋势和资金支撑还在，所以更像回踩，不是直接转空。' : '同时缺少资金承接，需要防止回撤扩大。'}`;
      const confidence = Math.round(Math.max(51, Math.min(86, 58 + Math.abs(change) * 5 + (volumeStrong ? 7 : 0) - (rsiHot ? 4 : 0))));
      const candle: ForecastCandle = {
        time: addCandleTime(last.time, index + 1, daily.interval), open, close,
        high: Math.max(open, close) + wick,
        low: Math.min(open, close) - wick * (.8 + seededValue(seed + 11) * .35),
        volume, quoteVolume: 0, confidence,
        summary,
        drivers,
        confirm: up ? `如果收盘能站稳 ${formatPrice(Math.max(open, previous))} 上方，而且成交量至少达到这根预计的 ${volumeRatio.toFixed(2)} 倍均量，我才认为上涨走出来了。` : `如果收盘真的跌破 ${formatPrice(Math.min(open, previous))}，我才认为这次回踩成立。`,
        invalidation: up ? `如果价格反而跌破 ${formatPrice(Math.min(open, close) - wick * .8)}，说明买盘没有接住，这根看涨判断就是错的。` : `如果价格重新站上 ${formatPrice(Math.max(open, close) + wick)}，说明卖压没有延续，这根看跌判断就是错的。`,
      };
      previousWasUp = up;
      previous = close;
      return candle;
    });
    const lows = virtualCandles.map((candle) => candle.low);
    const highs = virtualCandles.map((candle) => candle.high);
    const expectedReturn = ((virtualCandles.at(-1)!.close - price) / price) * 100;
    const invalidation = config.scenario === 'bull' ? Math.max(m.sma7, price - m.atr14 * 1.2) : config.scenario === 'bear' ? Math.min(m.high30, price + m.atr14) : Math.max(m.sma30, price - m.atr14 * 1.5);
    return {
      ...config, expectedReturn, targetLow: Math.min(...lows), targetHigh: Math.max(...highs), invalidation, virtualCandles,
      reasons: [
        { label: '趋势', value: price > m.sma200 && m.sma7 > m.sma30 ? '均线多头排列' : '均线仍有分歧', tone: price > m.sma200 && m.sma7 > m.sma30 ? 'positive' : 'neutral' },
        { label: '动量', value: `RSI ${m.rsi14.toFixed(0)}${m.rsi14 > 75 ? '，明显过热' : m.rsi14 < 35 ? '，接近超卖' : '，处于中段'}`, tone: m.rsi14 > 75 ? 'negative' : 'neutral' },
        { label: '资金', value: `ETF 5日 ${flowLabel(intel?.etf.fiveDayTotal)}`, tone: (intel?.etf.fiveDayTotal ?? 0) > 0 ? 'positive' : 'negative' },
        { label: '杠杆', value: `资金费率 ${intel?.derivatives.fundingRate?.toFixed(4) ?? '—'}%`, tone: (intel?.derivatives.fundingRate ?? 0) > .03 ? 'negative' : 'neutral' },
        { label: '波动', value: `ATR ${formatPrice(m.atr14)} · 量比 ${m.volumeRatio.toFixed(2)}`, tone: m.volumeRatio > 1 ? 'positive' : 'neutral' },
      ],
    };
  });
}

function DailyChart({ candles, range, interval, forecast, selectedIndex, onSelect }: { candles: Candle[]; range: string; interval: CandleInterval; forecast?: Forecast; selectedIndex: number; onSelect: (index: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartGeometry = useRef<{ rows: number; total: number; left: number; right: number } | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const rangeCounts: Record<string, number> = { '24H': 24, '72H': 72, '168H': 168, '7D': 7, '30D': 30, '90D': 90, '1Y': 200, '12M': 12, '36M': 36, '60M': 60 };
      const count = rangeCounts[range] ?? 30;
      const rows = candles.slice(-count);
      const future = forecast?.virtualCandles ?? [];
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
      const ctx = canvas.getContext('2d'); if (!ctx || rows.length < 2) return;
      ctx.scale(ratio, ratio);
      const w = rect.width; const h = rect.height; const left = 8; const right = 58; const top = 12; const priceBottom = h * .72; const volTop = h * .80; const bottom = h - 22;
      const prices = [...rows, ...future].flatMap((row) => [row.high, row.low]); const min = Math.min(...prices); const max = Math.max(...prices); const span = max - min || 1;
      const totalPoints = rows.length + future.length;
      chartGeometry.current = { rows: rows.length, total: totalPoints, left, right };
      const x = (index: number) => left + index * ((w - left - right) / Math.max(1, totalPoints - 1));
      const y = (price: number) => top + (max - price) / span * (priceBottom - top);
      ctx.strokeStyle = '#202733'; ctx.lineWidth = 1; ctx.setLineDash([4, 5]); ctx.fillStyle = '#66717f'; ctx.font = '9px ui-monospace';
      for (let i = 0; i < 4; i += 1) { const py = top + i * ((priceBottom - top) / 3); ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(w - right, py); ctx.stroke(); ctx.fillText(`$${Math.round(max - i * span / 3).toLocaleString()}`, w - right + 7, py + 3); }
      ctx.setLineDash([]); ctx.strokeStyle = '#f7931a'; ctx.lineWidth = 2; ctx.beginPath(); rows.forEach((row, index) => { if (index === 0) ctx.moveTo(x(index), y(row.close)); else ctx.lineTo(x(index), y(row.close)); }); ctx.stroke();
      const gradient = ctx.createLinearGradient(0, top, 0, priceBottom); gradient.addColorStop(0, 'rgba(247,147,26,.20)'); gradient.addColorStop(1, 'rgba(247,147,26,0)'); ctx.lineTo(x(rows.length - 1), priceBottom); ctx.lineTo(x(0), priceBottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
      if (future.length) {
        const dividerX = x(rows.length - 1) + (x(rows.length) - x(rows.length - 1)) / 2;
        ctx.fillStyle = 'rgba(163,107,255,.055)'; ctx.fillRect(dividerX, top, w - right - dividerX, bottom - top);
        ctx.strokeStyle = 'rgba(163,107,255,.5)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(dividerX, top); ctx.lineTo(dividerX, bottom); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#a975ff'; ctx.font = '9px ui-monospace'; ctx.fillText('虚拟K线', dividerX + 7, top + 11);
        const slot = (w - left - right) / Math.max(1, totalPoints - 1);
        const bodyWidth = Math.max(3, Math.min(11, slot * .58));
        future.forEach((row, index) => {
          const px = x(rows.length + index); const up = row.close >= row.open; const color = up ? '#42ddb5' : '#ff7182';
          if (index === selectedIndex) { ctx.fillStyle = 'rgba(169,117,255,.16)'; ctx.beginPath(); ctx.arc(px, y(row.close), Math.max(9, bodyWidth), 0, Math.PI * 2); ctx.fill(); }
          ctx.strokeStyle = color; ctx.globalAlpha = .78; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, y(row.high)); ctx.lineTo(px, y(row.low)); ctx.stroke();
          ctx.fillStyle = color; const bodyTop = y(Math.max(row.open, row.close)); const bodyHeight = Math.max(2, Math.abs(y(row.open) - y(row.close))); ctx.fillRect(px - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight); ctx.globalAlpha = 1;
        });
      }
      const maxVolume = Math.max(...rows.map((row) => row.volume), 1); const barWidth = Math.max(1, (w - left - right) / rows.length * .6);
      rows.forEach((row, index) => { const vh = (row.volume / maxVolume) * (bottom - volTop); ctx.fillStyle = row.close >= row.open ? 'rgba(32,213,165,.55)' : 'rgba(255,96,115,.48)'; ctx.fillRect(x(index) - barWidth / 2, bottom - vh, barWidth, vh); });
      ctx.fillStyle = '#66717f'; ctx.font = '9px ui-monospace'; const marks = [0, Math.floor((rows.length - 1) / 2), totalPoints - 1]; marks.forEach((index, mark) => { const row = index < rows.length ? rows[index] : future[index - rows.length]; const label = interval === '1h' ? new Date(row.time).toLocaleString('zh-CN', { day: '2-digit', hour: '2-digit', hour12: false }) : interval === '1M' ? new Date(row.time).toLocaleDateString('zh-CN', { year: '2-digit', month: '2-digit' }) : new Date(row.time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); ctx.fillText(label, mark === 2 ? x(index) - 30 : x(index), h - 4); });
    };
    draw(); const observer = new ResizeObserver(draw); observer.observe(canvas); return () => observer.disconnect();
  }, [candles, range, interval, forecast, selectedIndex]);
  const selectFromCanvas = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; const geometry = chartGeometry.current; const futureLength = forecast?.virtualCandles.length ?? 0;
    if (!canvas || !geometry || !futureLength) return;
    const rect = canvas.getBoundingClientRect(); const localX = event.clientX - rect.left;
    const slot = (rect.width - geometry.left - geometry.right) / Math.max(1, geometry.total - 1);
    const index = Math.round((localX - geometry.left) / slot) - geometry.rows;
    if (index >= 0 && index < futureLength) onSelect(index);
  };
  return <div className="price-chart real-chart"><canvas ref={canvasRef} onClick={selectFromCanvas} aria-label={`${range} BTC真实与虚拟K线图，点击虚拟K线查看原因`} /></div>;
}

export default function Home() {
  const [markets, setMarkets] = useState<Record<ExchangeId, MarketData>>({ coinbase: emptyMarket(), binance: emptyMarket(), okx: emptyMarket(), bybit: emptyMarket(), hyperliquid: emptyMarket() });
  const [marketInterval, setMarketInterval] = useState<CandleInterval>('1d');
  const [range, setRange] = useState('30D');
  const [alerts, setAlerts] = useState(true);
  const [activeNav, setActiveNav] = useState('overview');
  const [intelligence, setIntelligence] = useState<IntelligenceData | null>(null);
  const [daily, setDaily] = useState<DailyData | null>(null);
  const [forecastScenario, setForecastScenario] = useState<ForecastScenario>('base');
  const [forecastHorizon, setForecastHorizon] = useState(7);
  const [selectedCandleIndex, setSelectedCandleIndex] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let closed = false; const sockets = new Set<WebSocket>(); const timers = new Set<ReturnType<typeof setTimeout>>(); const heartbeats = new Set<ReturnType<typeof setInterval>>();
    const patch = (id: ExchangeId, data: Partial<MarketData>) => setMarkets((current) => ({ ...current, [id]: { ...current[id], ...data } }));
    const schedule = (fn: () => void) => { if (closed) return; const timer = setTimeout(() => { timers.delete(timer); fn(); }, 3500); timers.add(timer); };
    const connectCoinbase = () => { patch('coinbase', { status: 'connecting' }); const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com'); sockets.add(ws); ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker' })); ws.onmessage = (event) => { try { const t = JSON.parse(event.data).events?.[0]?.tickers?.[0]; if (!t?.price) return; patch('coinbase', { price: +t.price, change: +t.price_percent_chg_24_h, high: +t.high_24_h, low: +t.low_24_h, volume: +t.volume_24_h, status: 'live', updatedAt: Date.now() }); } catch {} }; ws.onerror = () => patch('coinbase', { status: 'offline' }); ws.onclose = () => { sockets.delete(ws); patch('coinbase', { status: 'offline' }); schedule(connectCoinbase); }; };
    const connectBinance = () => { patch('binance', { status: 'connecting' }); const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker'); sockets.add(ws); ws.onmessage = (event) => { try { const t = JSON.parse(event.data); if (!t?.c) return; patch('binance', { price: +t.c, change: +t.P, high: +t.h, low: +t.l, volume: +t.v, status: 'live', updatedAt: Date.now() }); } catch {} }; ws.onerror = () => patch('binance', { status: 'offline' }); ws.onclose = () => { sockets.delete(ws); patch('binance', { status: 'offline' }); schedule(connectBinance); }; };
    const connectOkx = () => { patch('okx', { status: 'connecting' }); const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public'); sockets.add(ws); ws.onopen = () => ws.send(JSON.stringify({ id: 'btc24h', op: 'subscribe', args: [{ channel: 'tickers', instId: 'BTC-USDT' }] })); ws.onmessage = (event) => { try { const t = JSON.parse(event.data).data?.[0]; if (!t?.last) return; const last = +t.last; const open = +t.open24h; patch('okx', { price: last, change: open ? (last - open) / open * 100 : null, high: +t.high24h, low: +t.low24h, volume: +t.vol24h, status: 'live', updatedAt: Date.now() }); } catch {} }; ws.onerror = () => patch('okx', { status: 'offline' }); ws.onclose = () => { sockets.delete(ws); patch('okx', { status: 'offline' }); schedule(connectOkx); }; };
    const connectBybit = () => { patch('bybit', { status: 'connecting' }); const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot'); sockets.add(ws); ws.onopen = () => { ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT'] })); const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' })); }, 20_000); heartbeats.add(ping); }; ws.onmessage = (event) => { try { const t = JSON.parse(event.data).data; if (!t?.lastPrice) return; patch('bybit', { price: +t.lastPrice, change: +t.price24hPcnt * 100, high: +t.highPrice24h, low: +t.lowPrice24h, volume: +t.volume24h, status: 'live', updatedAt: Date.now() }); } catch {} }; ws.onerror = () => patch('bybit', { status: 'offline' }); ws.onclose = () => { sockets.delete(ws); patch('bybit', { status: 'offline' }); schedule(connectBybit); }; };
    const connectHyperliquid = () => { patch('hyperliquid', { status: 'connecting' }); const ws = new WebSocket('wss://api.hyperliquid.xyz/ws'); sockets.add(ws); ws.onopen = () => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin: 'BTC' } })); ws.onmessage = (event) => { try { const payload = JSON.parse(event.data); const ctx = payload.data?.ctx; if (!ctx?.markPx) return; const price = +(ctx.midPx || ctx.markPx); const previous = +ctx.prevDayPx; patch('hyperliquid', { price, change: previous ? (price - previous) / previous * 100 : null, high: null, low: null, volume: ctx.dayNtlVlm ? +ctx.dayNtlVlm / price : null, status: 'live', updatedAt: Date.now() }); } catch {} }; ws.onerror = () => patch('hyperliquid', { status: 'offline' }); ws.onclose = () => { sockets.delete(ws); patch('hyperliquid', { status: 'offline' }); schedule(connectHyperliquid); }; };
    connectCoinbase(); connectBinance(); connectOkx(); connectBybit(); connectHyperliquid();
    return () => { closed = true; timers.forEach(clearTimeout); heartbeats.forEach(clearInterval); sockets.forEach((ws) => ws.close()); };
  }, []);
  useEffect(() => {
    let stopped = false;
    const load = async () => { try { const response = await fetch('/api/intelligence', { cache: 'no-store' }); if (!response.ok) throw new Error(); const payload = await response.json(); if (!stopped) setIntelligence(payload); } catch {} };
    load(); const timer = setInterval(load, 60_000); return () => { stopped = true; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let stopped = false; setDaily(null);
    const load = async () => { try { const response = await fetch(`/api/daily?interval=${marketInterval}`, { cache: 'no-store' }); if (!response.ok) throw new Error(); const payload = await response.json(); if (!stopped) setDaily(payload); } catch {} };
    load(); const timer = setInterval(load, 60_000); return () => { stopped = true; clearInterval(timer); };
  }, [marketInterval]);

  const currentMarkets = exchanges.map(({ id }) => markets[id]).filter((market) => market.status === 'live' && market.price !== null && market.updatedAt && now - market.updatedAt < 15_000);
  const compositePrice = currentMarkets.length ? currentMarkets.reduce((sum, market) => sum + (market.price ?? 0), 0) / currentMarkets.length : daily?.candles.at(-1)?.close ?? null;
  const compositeChange = currentMarkets.length ? currentMarkets.reduce((sum, market) => sum + (market.change ?? 0), 0) / currentMarkets.length : daily?.metrics.dayChange ?? null;
  const high24h = currentMarkets.length ? Math.max(...currentMarkets.map((m) => m.high ?? -Infinity)) : daily?.candles.at(-1)?.high ?? null;
  const low24h = currentMarkets.length ? Math.min(...currentMarkets.map((m) => m.low ?? Infinity)) : daily?.candles.at(-1)?.low ?? null;
  const volume24h = currentMarkets.length ? currentMarkets.reduce((sum, market) => sum + (market.volume ?? 0), 0) : null;
  const forecasts = useMemo(() => buildForecasts(daily, intelligence, compositePrice, forecastHorizon), [daily, intelligence, compositePrice, forecastHorizon]);
  const forecast = forecasts.find((item) => item.scenario === forecastScenario) ?? forecasts[0];
  const historyOptions = marketInterval === '1h' ? ['24H', '72H', '168H'] : marketInterval === '1M' ? ['12M', '36M', '60M'] : ['7D', '30D', '90D', '1Y'];
  const horizonOptions = marketInterval === '1h' ? [6, 12, 24] : marketInterval === '1M' ? [1, 3, 6] : [3, 7, 14];
  const switchInterval = (interval: CandleInterval) => { setMarketInterval(interval); setRange(interval === '1h' ? '72H' : interval === '1M' ? '36M' : '30D'); setForecastHorizon(interval === '1h' ? 12 : interval === '1M' ? 3 : 7); setForecastScenario('base'); setSelectedCandleIndex(0); };
  const selectedCandle = forecast?.virtualCandles[Math.min(selectedCandleIndex, Math.max(0, (forecast?.virtualCandles.length ?? 1) - 1))];
  const etfRecent = intelligence?.etf.recent ?? []; const maxEtf = Math.max(1, ...etfRecent.map((row) => Math.abs(row.total)));
  const topEtfFunds = Object.entries(intelligence?.etf.latest?.funds ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2);
  const latestUpdate = Math.max(0, ...currentMarkets.map((m) => m.updatedAt ?? 0));
  const navigate = (id: string) => { setActiveNav(id); if (id === 'overview') window.scrollTo({ top: 0, behavior: 'smooth' }); else document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); };
  const records = [
    ...exchanges.map((exchange) => ({ time: 'LIVE', tone: markets[exchange.id].updatedAt && now - markets[exchange.id].updatedAt < 15_000 ? 'green' : 'muted', tag: exchange.name, text: ageLabel(markets[exchange.id].updatedAt, now), value: formatPrice(markets[exchange.id].price) })),
    { time: 'K线', tone: daily ? 'green' : 'muted', tag: daily?.source ?? '行情', text: daily ? `${intervalName(daily.interval)}K UTC · 自动同步` : '加载中', value: daily ? `${daily.candles.length}根` : '—' },
    { time: 'ETF', tone: intelligence?.etf.status === 'live' ? 'green' : 'orange', tag: 'Farside', text: intelligence?.etf.latest?.date ?? '加载中', value: flowLabel(intelligence?.etf.latest?.total) },
  ];

  return <main className="app-shell" id="overview">
    <header className="topbar"><button className="brand-block brand-button" onClick={() => navigate('overview')}><span className="brand-mark">₿</span><span><span className="brand-name">BTC 24h <b>ONLINE</b></span><span className="brand-sub">MULTI-MARKET DECISION MONITOR</span></span></button><nav className="main-nav">{[['overview','总览'],['market','行情'],['signals','数据'],['records','记录']].map(([id,label]) => <button key={id} className={activeNav === id ? 'active' : ''} onClick={() => navigate(id)}>{label}</button>)}</nav><div className="top-actions"><button className={`live-chip ${currentMarkets.length ? 'live' : 'offline'}`} onClick={() => navigate('market')}><i /> {currentMarkets.length}/{exchanges.length} 实时</button><button className="icon-button" onClick={() => setAlerts(!alerts)}>{alerts ? '●' : '○'}</button><button className="profile-button">YK</button></div></header>
    <div className="dashboard">
      <section className="market-hero">
        <div className="hero-topline"><div className="hero-price"><div className="pair-line"><strong>BTC 综合价</strong><span>{currentMarkets.length}/{exchanges.length} LIVE</span></div><div className="price-line"><h1>{formatPrice(compositePrice)}</h1><span className={(compositeChange ?? 0) < 0 ? 'negative' : 'positive'}>{signed(compositeChange ?? undefined)}</span></div><p className="source-line">最后更新 {ageLabel(latestUpdate || null, now)} · 5 EXCHANGES</p></div><div className="decision-snapshot"><span>当前核心判断 · {intervalName(marketInterval)}K</span><strong>{forecast?.direction ?? '正在计算'}</strong><div><b>{forecast ? `${forecast.label} ${forecast.probability}%` : '等待数据'}</b><em>失效位 {formatPrice(forecast?.invalidation)}</em></div></div><div className="market-stats"><div><span>24h 高</span><b>{formatPrice(high24h)}</b></div><div><span>24h 低</span><b>{formatPrice(low24h)}</b></div><div><span>五所成交</span><b>{formatVolume(volume24h)}</b></div></div></div>
        <div className="interval-row"><div className="interval-switch">{([['1h','小时'],['1d','日'],['1M','月']] as Array<[CandleInterval,string]>).map(([value,label]) => <button key={value} className={marketInterval === value ? 'active' : ''} onClick={() => switchInterval(value)}>{label}K</button>)}</div><span>切换周期后，预测时间与判断原因会重新计算</span></div>
        <div className="market-workspace">
          <div className="market-chart-column"><div className="chart-toolbar"><div className="timeframes">{historyOptions.map((item) => <button key={item} className={range === item ? 'active' : ''} onClick={() => setRange(item)}>{item}</button>)}</div><div className="chart-legend"><span className="dot orange" />真实收盘 <span className="dot purple" />虚拟K线 <span className="dot green" />成交量</div></div>
          {daily ? <DailyChart candles={daily.candles} range={range} interval={marketInterval} forecast={forecast} selectedIndex={selectedCandleIndex} onSelect={setSelectedCandleIndex} /> : <div className="chart-loading">正在读取{intervalName(marketInterval)}K数据…</div>}
          {forecast && <div className="virtual-analysis-zone"><div className="virtual-analysis-title"><div><span className="eyebrow">逐根K线分析</span><b>点击每一根，右侧查看完整原因</b></div><span>{forecast.virtualCandles.length} 根 · {forecast.label}</span></div><div className="virtual-timeline" aria-label="虚拟K线精确时间">{forecast.virtualCandles.map((candle, index) => <button type="button" className={selectedCandleIndex === index ? 'active' : ''} key={candle.time} onClick={() => setSelectedCandleIndex(index)} aria-expanded={selectedCandleIndex === index}><time>{formatCandleTime(candle.time, marketInterval)}</time><div className="virtual-card-price"><b className={candle.close >= candle.open ? 'positive' : 'negative'}>{formatPrice(candle.close)}</b><em className={candle.close >= candle.open ? 'up' : 'down'}>{candle.close >= candle.open ? '走高' : '走低'} {candle.confidence}%</em></div><span>第{index + 1}根 · {candle.close >= candle.open ? '预计阳线' : '预计阴线'}</span><p>{candle.summary}</p></button>)}</div></div>}
          <div className="daily-source">{daily?.source ?? '市场数据'} · 原始K线 UTC · 预测时间 JST · 紫色区域为情景推演</div></div>
          {selectedCandle && <section className="candle-explanation candle-explanation-side" aria-live="polite">
            <div className="candle-explanation-head"><div><span>第{selectedCandleIndex + 1}根虚拟K线 · {formatCandleTime(selectedCandle.time, marketInterval)}</span><h3>为什么判断这根{selectedCandle.close >= selectedCandle.open ? '走高' : '走低'}</h3></div><div className={`candle-verdict ${selectedCandle.close >= selectedCandle.open ? 'up' : 'down'}`}><b>{selectedCandle.close >= selectedCandle.open ? '预计上涨' : '预计下跌'}</b><span>置信度 {selectedCandle.confidence}%</span></div></div>
            <p className="candle-summary">{selectedCandle.summary}</p>
            <div className="candle-driver-grid">{selectedCandle.drivers.map((driver) => <article className={driver.impact} key={driver.label}><span>{driver.impact === 'up' ? '↑' : driver.impact === 'down' ? '↓' : '—'} {driver.label}</span><p>{driver.detail}</p></article>)}</div>
            <div className="candle-conditions"><div><span>需要看到什么才算确认</span><b>{selectedCandle.confirm}</b></div><div><span>什么情况说明判断错了</span><b>{selectedCandle.invalidation}</b></div></div>
          </section>}
        </div>
      </section>

      <section className="forecast-panel panel">
        <div className="forecast-header"><div><span className="eyebrow">{intervalName(marketInterval)}K预判系统</span><h2>{forecast?.direction ?? '等待数据'}</h2><p>未来K线是概率推演，不是真实报价；切换周期会重新计算原因</p></div><div className="forecast-controls"><div className="scenario-tabs">{forecasts.map((item) => <button key={item.scenario} className={forecastScenario === item.scenario ? 'active' : ''} onClick={() => { setForecastScenario(item.scenario); setSelectedCandleIndex(0); }}><b>{item.label}</b><span>{item.probability}%</span></button>)}</div><div className="horizon-tabs">{horizonOptions.map((value) => <button key={value} className={forecastHorizon === value ? 'active' : ''} onClick={() => { setForecastHorizon(value); setSelectedCandleIndex(0); }}>{value}{marketInterval === '1h' ? '小时' : marketInterval === '1M' ? '月' : '天'}</button>)}</div></div></div>
        {forecast && <div className="forecast-body"><div className="forecast-summary"><div className="forecast-direction"><span>预期变化</span><strong className={forecast.expectedReturn >= 0 ? 'positive' : 'negative'}>{signed(forecast.expectedReturn)}</strong><small>{forecast.label} · 概率 {forecast.probability}%</small></div><div><span>推演区间</span><b>{formatPrice(forecast.targetLow)} – {formatPrice(forecast.targetHigh)}</b></div><div><span>情景失效位</span><b>{formatPrice(forecast.invalidation)}</b></div></div><div className="reason-grid">{forecast.reasons.map((reason) => <article key={reason.label} className={reason.tone}><span>{reason.label}</span><b>{reason.value}</b></article>)}</div></div>}
        <div className="forecast-note"><b>怎么看：</b>先看概率最高的基准情景；价格穿越失效位后，切换到另外两个情景重新判断。虚拟K线使用均线、RSI、ATR、成交量、ETF和资金费率计算。</div>
      </section>

      <section className="exchange-panel panel nav-section" id="market"><div className="section-title"><div><span className="eyebrow">实时行情</span><h2>五所同步状态</h2></div><span className={`feed-count ${currentMarkets.length ? 'live' : 'offline'}`}>{currentMarkets.length}/{exchanges.length} 正常</span></div><div className="exchange-grid">{exchanges.map((exchange) => { const data = markets[exchange.id]; const fresh = Boolean(data.updatedAt && now - data.updatedAt < 15_000); return <article className="exchange-card" key={exchange.id}><div className="exchange-head"><span className={`exchange-logo ${exchange.color}`}>{exchange.mark}</span><div><b>{exchange.name}</b><span>{exchange.pair}</span></div><em className={fresh ? 'live' : 'offline'}><i />{fresh ? ageLabel(data.updatedAt, now) : data.status === 'connecting' ? '连接中' : '数据延迟'}</em></div><div className="exchange-price"><strong>{formatPrice(data.price)}</strong><span className={(data.change ?? 0) < 0 ? 'negative' : 'positive'}>{signed(data.change ?? undefined)}</span></div><div className="exchange-stats"><div><span>24h 高</span><b>{data.high == null ? '—' : formatPrice(data.high)}</b></div><div><span>24h 低</span><b>{data.low == null ? '—' : formatPrice(data.low)}</b></div><div><span>成交量</span><b>{formatVolume(data.volume)}</b></div></div></article>; })}</div></section>

      <section className="daily-metrics panel"><div className="section-title"><div><span className="eyebrow">{intervalName(marketInterval)}K数据</span><h2>趋势与动量</h2></div><span className="data-source">{daily ? new Date(daily.updatedAt).toLocaleString('zh-CN') : '同步中'}</span></div><div className="daily-grid">{[
        [`近7${intervalName(marketInterval)}`, signed(daily?.metrics.sevenDayChange), (daily?.metrics.sevenDayChange ?? 0) >= 0], [`近30${intervalName(marketInterval)}`, signed(daily?.metrics.thirtyDayChange), (daily?.metrics.thirtyDayChange ?? 0) >= 0], ['RSI 14', daily ? daily.metrics.rsi14.toFixed(1) : '—', (daily?.metrics.rsi14 ?? 50) < 70], [`7${intervalName(marketInterval)}均线`, formatPrice(daily?.metrics.sma7), (compositePrice ?? 0) > (daily?.metrics.sma7 ?? Infinity)], [`30${intervalName(marketInterval)}均线`, formatPrice(daily?.metrics.sma30), (compositePrice ?? 0) > (daily?.metrics.sma30 ?? Infinity)], [`200${intervalName(marketInterval)}均线`, formatPrice(daily?.metrics.sma200), (compositePrice ?? 0) > (daily?.metrics.sma200 ?? Infinity)], [`30${intervalName(marketInterval)}高点`, formatPrice(daily?.metrics.high30), false], [`30${intervalName(marketInterval)}低点`, formatPrice(daily?.metrics.low30), true],
      ].map(([label,value,good]) => <div key={String(label)}><span>{label}</span><b className={good ? 'positive' : undefined}>{value}</b></div>)}</div></section>

      <section className="metrics-grid nav-section" id="signals"><article className="metric-card panel intelligence-card"><div className="metric-head"><span className="metric-icon orange-bg">$</span><span className={`badge ${intelligence?.etf.status === 'live' ? 'normal' : 'pending'}`}>{intelligence?.etf.status === 'live' ? '已同步' : '快照'}</span></div><div className="eyebrow-row"><span className="eyebrow">ETF 净流入</span><a href="https://farside.co.uk/btc/" target="_blank" rel="noreferrer">Farside ↗</a></div><h3 className={(intelligence?.etf.latest?.total ?? 0) < 0 ? 'negative' : 'positive'}>{flowLabel(intelligence?.etf.latest?.total)}</h3><p>{intelligence?.etf.latest?.date ?? '等待数据'} · 近5日 {flowLabel(intelligence?.etf.fiveDayTotal)}</p><div className="flow-bars">{etfRecent.map((row) => <i key={row.date} className={row.total >= 0 ? 'inflow' : 'outflow'} style={{ height: `${Math.max(10, Math.abs(row.total) / maxEtf * 100)}%` }} title={`${row.date} ${flowLabel(row.total)}`} />)}</div><div className="fund-flow-list">{topEtfFunds.map(([ticker,value]) => <span key={ticker}><b>{ticker}</b><em className={value < 0 ? 'negative' : 'positive'}>{flowLabel(value)}</em></span>)}</div></article>
      <article className="metric-card panel intelligence-card"><div className="metric-head"><span className="metric-icon blue-bg">◎</span><span className={`badge ${intelligence?.whale.status === 'live' ? 'normal' : 'pending'}`}>{intelligence?.whale.status === 'live' ? '实时' : '未连接'}</span></div><div className="eyebrow-row"><span className="eyebrow">巨鲸活动</span><a href="https://mempool.space/" target="_blank" rel="noreferrer">mempool ↗</a></div><h3>{intelligence?.whale.largeCount ?? '—'} 笔 ≥100 BTC</h3><p>最近 {intelligence?.whale.sampleSize ?? 0} 笔未确认交易</p><div className="whale-value"><span>最大一笔</span><b>{intelligence?.whale.largest ? `${intelligence.whale.largest.btc.toLocaleString('en-US', { maximumFractionDigits: 2 })} BTC` : '—'}</b></div>{intelligence?.whale.largest && <a className="tx-link" href={`https://mempool.space/tx/${intelligence.whale.largest.txid}`} target="_blank" rel="noreferrer">查看交易 {intelligence.whale.largest.txid.slice(0, 10)}… ↗</a>}</article>
      <article className="metric-card panel intelligence-card"><div className="metric-head"><span className="metric-icon green-bg">↗</span><span className={`badge ${intelligence?.derivatives.status === 'live' ? 'normal' : 'pending'}`}>{intelligence?.derivatives.status === 'live' ? '实时' : '未连接'}</span></div><div className="eyebrow-row"><span className="eyebrow">衍生品</span><span className="data-source">Binance Futures</span></div><h3>{intelligence?.derivatives.fundingRate == null ? '—' : `${intelligence.derivatives.fundingRate >= 0 ? '+' : ''}${intelligence.derivatives.fundingRate.toFixed(4)}%`}</h3><p>BTCUSDT 永续资金费率</p><div className="dual-metric"><div><span>持仓量 OI</span><b>{compactUsd(intelligence?.derivatives.openInterestUsd)}</b></div><div><span>多空账户比</span><b>{intelligence?.derivatives.longShortRatio?.toFixed(3) ?? '—'}</b></div></div><div className="funding-time"><span>下次结算</span><b>{intelligence?.derivatives.nextFundingTime ? new Date(intelligence.derivatives.nextFundingTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'}</b></div></article>
      <article className="metric-card panel intelligence-card"><div className="metric-head"><span className="metric-icon purple-bg">◈</span><span className="badge normal">{intervalName(marketInterval)}K</span></div><span className="eyebrow">成交量</span><h3>{daily ? `${daily.metrics.volumeRatio.toFixed(2)}× 20${intervalName(marketInterval)}均量` : '—'}</h3><p>当前K线尚未完成，随成交持续变化</p><div className="dual-metric"><div><span>当前 BTC</span><b>{formatVolume(daily?.metrics.todayVolume)}</b></div><div><span>ATR 14</span><b>{formatPrice(daily?.metrics.atr14)}</b></div></div></article></section>

      <section className="events-panel panel nav-section full-records" id="records"><div className="section-title"><div><span className="eyebrow">系统记录</span><h2>同步日志</h2></div><span className="record-clock">每秒显示状态</span></div><div className="event-list">{records.map((event) => <div className="event-row" key={`${event.time}-${event.tag}`}><time>{event.time}</time><i className={event.tone} /><span className="event-tag">{event.tag}</span><p>{event.text}</p><b>{event.value}</b></div>)}</div></section>
    </div><div className={`toast ${alerts ? 'show' : ''}`}><i>✓</i><div><b>监控运行中</b><span>价格过期会在15秒内显示为延迟</span></div><button onClick={() => setAlerts(false)}>×</button></div>
  </main>;
}
