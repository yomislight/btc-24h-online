'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type FeedStatus = 'connecting' | 'live' | 'offline';
type ExchangeId = 'coinbase' | 'binance' | 'okx' | 'bybit' | 'hyperliquid';
type CandleInterval = '1h' | '1d' | '1M';
type MarketData = { price: number | null; change: number | null; high: number | null; low: number | null; volume: number | null; status: FeedStatus; updatedAt: number | null };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number };
type DailyData = {
  status: 'live'; source: string; sources: string[]; failedSources: string[]; interval: CandleInterval; unit: 'hour' | 'day' | 'month'; updatedAt: number; candles: Candle[];
  metrics: { dayChange: number; sevenDayChange: number; thirtyDayChange: number; sma7: number; sma30: number; sma200: number; rsi14: number; atr14: number; high30: number; low30: number; todayVolume: number; averageVolume20: number; volumeRatio: number };
  consensus: {
    requested: number; live: number; bullish: number; bearish: number; neutral: number; volumeConfirmCount: number; spreadPct: number;
    exchanges: Array<{ name: string; marketType: 'spot' | 'perp'; close: number; change: number; volumeRatio: number; direction: 'up' | 'down' | 'flat' }>;
  };
};
type IntelligenceData = {
  etf: { status: 'live' | 'snapshot'; source: string; sourceUrl: string; fiveDayTotal: number; latest: { date: string; total: number; funds: Record<string, number | null> } | null; recent: Array<{ date: string; total: number; funds: Record<string, number | null> }> };
  derivatives: { status: 'live' | 'offline'; source: string; fundingRate?: number; nextFundingTime?: number; openInterestBtc?: number; openInterestUsd?: number; longShortRatio?: number; updatedAt?: number };
  whale: { status: 'live' | 'offline'; source: string; thresholdBtc: number; sampleSize: number; largeCount: number; largest: { txid: string; btc: number; feeRate: number } | null; checkedAt?: number };
  collectedAt: number;
};
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

function buildForecasts(daily: DailyData | null, intel: IntelligenceData | null, livePrice: number | null, horizon: number): Forecast[] {
  if (!daily || !daily.candles.length) return [];
  const m = daily.metrics;
  const consensus = daily.consensus;
  const last = daily.candles.at(-1)!;
  const price = livePrice ?? last.close;
  const breadth = consensus.live ? (consensus.bullish - consensus.bearish) / consensus.live : 0;
  const volumeBreadth = consensus.live ? consensus.volumeConfirmCount / consensus.live : 0;
  const volumeStrong = consensus.volumeConfirmCount >= Math.ceil(consensus.live * .6);
  const majorityUp = consensus.bullish > consensus.bearish;
  const majorityDown = consensus.bearish > consensus.bullish;
  let trend = 0;
  if (price > m.sma200) trend += .9; else trend -= .9;
  if (m.sma7 > m.sma30) trend += .7; else trend -= .7;
  if (m.thirtyDayChange > 0) trend += .35; else trend -= .35;
  trend += breadth * 1.1;
  if (consensus.volumeConfirmCount >= Math.ceil(consensus.live * .6)) trend += breadth >= 0 ? .35 : -.35;
  if ((intel?.etf.fiveDayTotal ?? 0) > 0) trend += .5; else if ((intel?.etf.fiveDayTotal ?? 0) < 0) trend -= .5;
  if (m.rsi14 > 75) trend -= 1;
  if (m.rsi14 < 30) trend += .7;
  if (m.sevenDayChange > 20) trend -= .45;
  if ((intel?.derivatives.fundingRate ?? 0) > .03) trend -= .4;

  const bullProbability = Math.round(Math.max(15, Math.min(42, 26 + trend * 7)));
  const bearProbability = Math.round(Math.max(15, Math.min(42, 25 - trend * 6)));
  const baseProbability = 100 - bullProbability - bearProbability;
  const atrPct = Math.max(.012, Math.min(.06, m.atr14 / price));
  const configs: Array<{ scenario: ForecastScenario; label: string; probability: number; drift: number; direction: string }> = [
    { scenario: 'base', label: '基准震荡', probability: baseProbability, drift: Math.max(-.003, Math.min(.004, trend * .0012)), direction: trend >= 0 ? '高位震荡偏强' : '震荡偏弱' },
    { scenario: 'bull', label: '向上突破', probability: bullProbability, drift: atrPct * .24, direction: '突破后延续上行' },
    { scenario: 'bear', label: '回撤修正', probability: bearProbability, drift: -atrPct * .27, direction: '冲高后回撤' },
  ];

  return configs.map((config) => {
    let previous = price;
    let previousWasUp = last.close >= last.open;
    const virtualCandles = Array.from({ length: horizon }, (_, index) => {
      const basePhases = [.08, .03, -.10, .07, .04, -.08, .06];
      const bullPhases = [.12, .10, -.04, .13, .08, -.03, .10];
      const bearPhases = [-.12, -.09, .04, -.13, -.08, .03, -.10];
      const phase = (config.scenario === 'bull' ? bullPhases : config.scenario === 'bear' ? bearPhases : basePhases)[index % 7];
      const consensusPush = breadth * m.atr14 * .08;
      const heatAdjustment = m.rsi14 > 72 && index % 3 === 2 ? -m.atr14 * .10 : m.rsi14 < 32 && index % 3 === 2 ? m.atr14 * .10 : 0;
      const open = previous;
      const close = Math.max(1, previous * (1 + config.drift) + m.atr14 * phase + consensusPush + heatAdjustment);
      const wick = m.atr14 * (.18 + Math.min(.10, Math.abs(close - open) / Math.max(1, m.atr14) * .06));
      const volumeRatio = Math.max(.70, Math.min(1.35, .70 + volumeBreadth * .32 + Math.abs(breadth) * .18 + Math.abs(phase) * .45));
      const volume = m.averageVolume20 * volumeRatio;
      const change = (close - open) / open * 100;
      const up = close >= open;
      const trendPositive = price > m.sma30 && m.sma7 > m.sma30;
      const etfPositive = (intel?.etf.fiveDayTotal ?? 0) > 0;
      const rsiHot = m.rsi14 > 72;
      const moveSize = Math.abs(change) < .45 ? '小' : Math.abs(change) < 1 ? '普通' : '较强';
      const exchangeLine = `${consensus.live}所中，${consensus.bullish}所涨、${consensus.bearish}所跌、${consensus.neutral}所横盘`;
      const volumeAligned = (up && majorityUp) || (!up && majorityDown);
      const volumeOpposed = (up && majorityDown) || (!up && majorityUp);
      const volumeDetail = !volumeStrong
        ? `按当前K线进度折算，只有 ${consensus.volumeConfirmCount}/${consensus.live} 所达到各自近20根均量。量能没有形成多数，当前方向还不能靠成交量确认，这根只作为情景推演。`
        : volumeAligned
          ? `按当前K线进度折算，${consensus.volumeConfirmCount}/${consensus.live} 所达到各自近20根均量，而且多数方向与这根一致，${up ? '上推' : '下压'}有跨市场成交配合。`
          : volumeOpposed
            ? `虽然 ${consensus.volumeConfirmCount}/${consensus.live} 所达到各自近20根均量，但当前有量的一边是${majorityUp ? '上涨' : '下跌'}，并不支持这根${up ? '上涨' : '下跌'}；所以这里只按一次小幅${up ? '反弹' : '回踩'}处理。`
            : `${consensus.volumeConfirmCount}/${consensus.live} 所达到各自近20根均量，但五所方向没有形成多数，量能暂时不能确认这根。`;
      const stageReason = index === 0
        ? (up ? '第一根先按当前方向延续，但不直接假设会加速。' : '第一根先消化眼前卖压，不把回落直接看成趋势反转。')
        : up
          ? (previousWasUp ? '上一根收高后还有惯性，这根继续抬高，但涨幅按波动率收窄。' : '上一根回落后没有继续向下推演，这根按技术反弹处理。')
          : (previousWasUp ? '上一根上涨后进入获利回吐，这根安排一次正常回踩。' : '上一根已经走低，买盘仍未扭转节奏，这根继续下探。');
      const rsiImpact: 'up' | 'down' | 'neutral' = m.rsi14 > 72 ? 'down' : m.rsi14 < 32 ? 'up' : 'neutral';
      const rsiDetail = m.rsi14 > 72
        ? `RSI 14 为 ${m.rsi14.toFixed(1)}，已经进入明显过热区。${up ? '这会限制继续上冲的空间，所以不按大阳线推演。' : '获利盘容易松动，支持这根先回踩。'}`
        : m.rsi14 < 32
          ? `RSI 14 为 ${m.rsi14.toFixed(1)}，接近超卖。${up ? '空头动能衰减，有利于技术反弹。' : '继续追空的空间有限，需要防止快速反抽。'}`
          : `RSI 14 为 ${m.rsi14.toFixed(1)}，处于中间区域，动量没有过度拥挤，本根主要由趋势和量能决定。`;
      const funding = intel?.derivatives.fundingRate;
      const longShort = intel?.derivatives.longShortRatio;
      const leverageImpact: 'up' | 'down' | 'neutral' = funding != null && funding > .03 ? 'down' : funding != null && funding < -.01 ? 'up' : 'neutral';
      const leverageDetail = funding == null
        ? '衍生品数据暂未同步，这一项不参与本根方向加分。'
        : funding > .03
          ? `永续资金费率 ${funding.toFixed(4)}%，多头杠杆偏拥挤，价格上涨时更容易出现多头平仓回踩。`
          : funding < -.01
            ? `永续资金费率 ${funding.toFixed(4)}%，空头付费偏高，若价格上行可能触发空头回补。`
            : `永续资金费率 ${funding.toFixed(4)}%，杠杆没有过热${longShort != null ? `；账户多空比 ${longShort.toFixed(3)}` : ''}，暂时没有明显的强平压力。`;
      const drivers: ForecastCandle['drivers'] = [
        { label: up ? 'K线结构：为什么抬高' : 'K线结构：为什么压低', detail: `${stageReason} 本根预计波动约 ${Math.abs(change).toFixed(2)}%，低于当前 ATR ${formatPrice(m.atr14)} 所代表的常见波幅。`, impact: up ? 'up' : 'down' },
        { label: 'RSI：动量是否过热', detail: rsiDetail, impact: rsiImpact },
        { label: '均线：趋势有没有坏', detail: trendPositive ? `综合收盘仍在30${intervalName(daily.interval)}均线 ${formatPrice(m.sma30)} 上方，而且7${intervalName(daily.interval)}均线更高；${up ? '顺势抬高更合理。' : '因此这根下跌先看成回踩，不直接判定转空。'}` : `综合收盘与均线结构偏弱，${up ? '这根上涨只先看反弹。' : '这根下跌有趋势配合。'}`, impact: trendPositive ? 'up' : 'down' },
        { label: '成交量：有没有真实配合', detail: volumeDetail, impact: !volumeStrong ? 'neutral' : volumeAligned ? (up ? 'up' : 'down') : volumeOpposed ? (majorityUp ? 'up' : 'down') : 'neutral' },
        { label: 'ETF：机构资金有没有接', detail: etfPositive ? `ETF近5日合计净流入 ${flowLabel(intel?.etf.fiveDayTotal)}，说明中期资金仍在进场，回落时更容易出现承接。` : `ETF近5日为净流出 ${flowLabel(intel?.etf.fiveDayTotal)}，机构资金没有提供稳定承接，反弹持续性要打折。`, impact: etfPositive ? 'up' : 'down' },
        { label: '衍生品：杠杆是否拥挤', detail: leverageDetail, impact: leverageImpact },
        { label: '市场共振：交易所是否一致', detail: `${exchangeLine}。${majorityUp ? '多数市场同向上涨。' : majorityDown ? '多数市场同向下跌。' : '各市场方向分散，不能用单一交易所的波动下结论。'}${consensus.live < 5 ? ` 当前缺少 ${daily.failedSources.join('、')}，依据强度已下调。` : ''}`, impact: majorityUp ? 'up' : majorityDown ? 'down' : 'neutral' },
      ];
      const summary = up
        ? `这根看${moveSize}阳线。均线趋势${trendPositive ? '仍向上' : '尚未转强'}，ETF资金${etfPositive ? '仍在流入' : '没有承接'}；${rsiHot ? `但 RSI ${m.rsi14.toFixed(0)} 已过热，` : ''}${volumeStrong && volumeAligned ? '成交量也有配合。' : '成交量尚未确认，所以涨幅保守。'}`
        : `这根看${moveSize}阴线。${rsiHot ? `RSI ${m.rsi14.toFixed(0)} 过热，加上` : ''}${previousWasUp ? '前一根上涨后的获利回吐' : '短线动量减弱'}；${trendPositive || etfPositive ? '不过均线或ETF支撑还在，先看普通回踩，不直接判定转空。' : '资金与趋势都偏弱，需要防止回撤扩大。'}`;
      const agreement = consensus.live ? Math.abs(consensus.bullish - consensus.bearish) / consensus.live : 0;
      const confidence = Math.round(Math.max(48, Math.min(82, 50 + consensus.live / 5 * 9 + agreement * 16 + volumeBreadth * 6 - index * 1.2 - (rsiHot ? 3 : 0) - (consensus.spreadPct > .2 ? 3 : 0))));
      const candle: ForecastCandle = {
        time: addCandleTime(last.time, index + 1, daily.interval), open, close,
        high: Math.max(open, close) + wick,
        low: Math.min(open, close) - wick * (index % 2 === 0 ? .9 : 1.05),
        volume, quoteVolume: 0, confidence,
        summary,
        drivers,
        confirm: up ? `收盘站稳 ${formatPrice(open)} 上方，同时至少 ${Math.ceil(consensus.live * .6)} 所方向转涨，这根上涨才算确认。` : `收盘跌破 ${formatPrice(open)}，同时至少 ${Math.ceil(consensus.live * .6)} 所方向转跌，这根回落才算确认。`,
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
        { label: '五所方向', value: `${consensus.bullish}涨 / ${consensus.bearish}跌 / ${consensus.neutral}横盘`, tone: majorityUp ? 'positive' : majorityDown ? 'negative' : 'neutral' },
        { label: '趋势', value: price > m.sma200 && m.sma7 > m.sma30 ? '均线多头排列' : '均线仍有分歧', tone: price > m.sma200 && m.sma7 > m.sma30 ? 'positive' : 'neutral' },
        { label: '动量', value: `RSI ${m.rsi14.toFixed(0)}${m.rsi14 > 75 ? '，明显过热' : m.rsi14 < 35 ? '，接近超卖' : '，处于中段'}`, tone: m.rsi14 > 75 ? 'negative' : 'neutral' },
        { label: '资金', value: `ETF 5日 ${flowLabel(intel?.etf.fiveDayTotal)}`, tone: (intel?.etf.fiveDayTotal ?? 0) > 0 ? 'positive' : 'negative' },
        { label: '量能', value: `${consensus.volumeConfirmCount}/${consensus.live} 所达到均量`, tone: volumeStrong ? 'positive' : 'neutral' },
      ],
    };
  });
}

function DailyChart({ candles, range, interval, forecast, selectedIndex, onSelect }: { candles: Candle[]; range: string; interval: CandleInterval; forecast?: Forecast; selectedIndex: number; onSelect: (index: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartGeometry = useRef<{ rows: number; total: number; left: number; right: number } | null>(null);
  const [hoveredCandle, setHoveredCandle] = useState<{ candle: ForecastCandle; x: number; y: number } | null>(null);
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
  const hoverFromCanvas = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; const geometry = chartGeometry.current; const future = forecast?.virtualCandles ?? [];
    if (!canvas || !geometry || !future.length) { setHoveredCandle(null); return; }
    const rect = canvas.getBoundingClientRect(); const localX = event.clientX - rect.left;
    const slot = (rect.width - geometry.left - geometry.right) / Math.max(1, geometry.total - 1);
    const index = Math.round((localX - geometry.left) / slot) - geometry.rows;
    if (index < 0 || index >= future.length) { setHoveredCandle(null); return; }
    setHoveredCandle({ candle: future[index], x: Math.min(rect.width - 178, Math.max(8, localX + 12)), y: Math.max(8, event.clientY - rect.top - 82) });
  };
  return <div className="price-chart real-chart"><canvas ref={canvasRef} onClick={selectFromCanvas} onMouseMove={hoverFromCanvas} onMouseLeave={() => setHoveredCandle(null)} aria-label={`${range} BTC真实与虚拟K线图，点击虚拟K线查看原因，悬停查看具体价格`} />{hoveredCandle && <div className="chart-price-tooltip" style={{ left: hoveredCandle.x, top: hoveredCandle.y }}><time>{formatCandleTime(hoveredCandle.candle.time, interval)}</time><strong className={hoveredCandle.candle.close >= hoveredCandle.candle.open ? 'positive' : 'negative'}>收盘 {formatPrice(hoveredCandle.candle.close)}</strong><span>开盘 {formatPrice(hoveredCandle.candle.open)}</span><span>最高 {formatPrice(hoveredCandle.candle.high)} · 最低 {formatPrice(hoveredCandle.candle.low)}</span></div>}</div>;
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
  const [now, setNow] = useState(0);

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
    let stopped = false;
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
  const switchInterval = (interval: CandleInterval) => { setDaily(null); setMarketInterval(interval); setRange(interval === '1h' ? '72H' : interval === '1M' ? '36M' : '30D'); setForecastHorizon(interval === '1h' ? 12 : interval === '1M' ? 3 : 7); setForecastScenario('base'); setSelectedCandleIndex(0); };
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
          {forecast && <div className="virtual-analysis-zone"><div className="virtual-analysis-title"><div><span className="eyebrow">逐根K线分析</span><b>点击每一根，右侧查看完整原因</b></div><span>{forecast.virtualCandles.length} 根 · {forecast.label}</span></div><div className="virtual-timeline" aria-label="虚拟K线精确时间">{forecast.virtualCandles.map((candle, index) => <button type="button" className={selectedCandleIndex === index ? 'active' : ''} key={candle.time} onClick={() => setSelectedCandleIndex(index)} aria-expanded={selectedCandleIndex === index}><time>{formatCandleTime(candle.time, marketInterval)}</time><div className="virtual-card-price"><b className={candle.close >= candle.open ? 'positive' : 'negative'}>{formatPrice(candle.close)}</b><em className={candle.close >= candle.open ? 'up' : 'down'}>{candle.close >= candle.open ? '走高' : '走低'} · 依据{candle.confidence}%</em></div><span>第{index + 1}根 · {candle.close >= candle.open ? '预计阳线' : '预计阴线'}</span><p>{candle.summary}</p></button>)}</div></div>}
          <div className="daily-source">{daily?.source ?? '市场数据'} · 原始K线 UTC · 预测时间 JST · 紫色区域为情景推演</div></div>
          {selectedCandle && <section className="candle-explanation candle-explanation-side" aria-live="polite">
            <div className="candle-explanation-head"><div><span>第{selectedCandleIndex + 1}根虚拟K线 · {formatCandleTime(selectedCandle.time, marketInterval)}</span><h3>为什么判断这根{selectedCandle.close >= selectedCandle.open ? '走高' : '走低'}</h3></div><div className={`candle-verdict ${selectedCandle.close >= selectedCandle.open ? 'up' : 'down'}`}><b>{selectedCandle.close >= selectedCandle.open ? '预计上涨' : '预计下跌'}</b><span>依据强度 {selectedCandle.confidence}%</span></div></div>
            <p className="candle-summary">{selectedCandle.summary}</p>
            <div className="candle-driver-grid">{selectedCandle.drivers.map((driver) => <article className={driver.impact} key={driver.label}><span>{driver.impact === 'up' ? '↑' : driver.impact === 'down' ? '↓' : '—'} {driver.label}</span><p>{driver.detail}</p></article>)}</div>
            <div className="candle-conditions"><div><span>需要看到什么才算确认</span><b>{selectedCandle.confirm}</b></div><div><span>什么情况说明判断错了</span><b>{selectedCandle.invalidation}</b></div></div>
          </section>}
        </div>
      </section>

      <section className="forecast-panel panel">
        <div className="forecast-header"><div><span className="eyebrow">{intervalName(marketInterval)}K预判系统</span><h2>{forecast?.direction ?? '等待数据'}</h2><p>未来K线是概率推演，不是真实报价；切换周期会重新计算原因</p></div><div className="forecast-controls"><div className="scenario-tabs">{forecasts.map((item) => <button key={item.scenario} className={forecastScenario === item.scenario ? 'active' : ''} onClick={() => { setForecastScenario(item.scenario); setSelectedCandleIndex(0); }}><b>{item.label}</b><span>{item.probability}%</span></button>)}</div><div className="horizon-tabs">{horizonOptions.map((value) => <button key={value} className={forecastHorizon === value ? 'active' : ''} onClick={() => { setForecastHorizon(value); setSelectedCandleIndex(0); }}>{value}{marketInterval === '1h' ? '小时' : marketInterval === '1M' ? '月' : '天'}</button>)}</div></div></div>
        {forecast && <div className="forecast-body"><div className="forecast-summary"><div className="forecast-direction"><span>预期变化</span><strong className={forecast.expectedReturn >= 0 ? 'positive' : 'negative'}>{signed(forecast.expectedReturn)}</strong><small>{forecast.label} · 概率 {forecast.probability}%</small></div><div><span>推演区间</span><b>{formatPrice(forecast.targetLow)} – {formatPrice(forecast.targetHigh)}</b></div><div><span>情景失效位</span><b>{formatPrice(forecast.invalidation)}</b></div></div><div className="reason-grid">{forecast.reasons.map((reason) => <article key={reason.label} className={reason.tone}><span>{reason.label}</span><b>{reason.value}</b></article>)}</div></div>}
        <div className="forecast-note"><b>怎么算：</b>五所K线先按同一时间合并，再看多数方向、各所量能、综合均线、RSI、ATR、ETF与资金费率。虚拟K线不再加入随机涨跌；“依据强度”表示当前数据是否一致，不代表未来命中率。</div>
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
