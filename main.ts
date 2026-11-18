// Dip-buyer for the BTC 24h race: buy a symbol 2% below its 240-bar rolling
// high, take profit at +2% from entry, trail the stop 1% under the peak
// since entry, and sit out 120 bars after a stop-out.
//
//   - Rolling high: the highest close of the last 240 bars per symbol.
//   - Entry: close <= high * 98 / 100, with a full 240 bars of history.
//   - Exit (take profit): close >= entry * 102 / 100 — sell the whole position.
//   - Exit (trailing stop): close <= peak * 99 / 100, peak the highest close
//     since entry — sell the whole position and cool down 120 bars.
//   - Sizing: one buy per symbol per batch, spending at most half the cash
//     on hand and never more than the weight room; a sell's proceeds never
//     fund a buy in the same reply (they only arrive next batch).

import { BPS, runBars, type OrderInput } from './vendor/makefun-bars.ts';

const WINDOW_BARS = 240;
const DIP_BPS = 200; // 2% below the rolling high
const TP_BPS = 200; // +2% take profit from entry
const TRAIL_BPS = 100; // 1% trailing stop under the peak
const COOLDOWN_BARS = 120;
const MAX_SLIPPAGE_BPS = 100;
const BUY_FRACTION_BPS = 5000; // spend at most half the cash on one buy

interface SymState {
  closes: bigint[]; // last WINDOW_BARS closes, oldest first
  entry: bigint | null; // close when the position first appeared
  peak: bigint | null; // highest close since entry
  coolUntil: number; // do not re-buy before this seq
}

const syms = new Map<string, SymState>();

function symState(symbol: string): SymState {
  let s = syms.get(symbol);
  if (s === undefined) {
    s = { closes: [], entry: null, peak: null, coolUntil: -1 };
    syms.set(symbol, s);
  }
  return s;
}

await runBars({
  onBatch(state, batch) {
    const orders: OrderInput[] = [];
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);

    // 1. Fold this batch's closes into each symbol's rolling window — even
    // during warm-up, so the window is full when trading opens. A position
    // we hold but never recorded an entry for (the buy filled after we
    // decided it) gets its entry anchored at the first close we see it at.
    for (const symbol of state.hello.symbols.map((s) => s.symbol)) {
      const c = state.close(symbol);
      if (c === null) continue;
      const s = symState(symbol);
      s.closes.push(c);
      if (s.closes.length > WINDOW_BARS) s.closes.shift();
      const pos = state.positions.get(symbol);
      if (pos !== undefined && s.entry === null) {
        s.entry = c;
        s.peak = c;
      }
      if (s.entry !== null && s.peak !== null && c > s.peak) s.peak = c;
    }

    // Warm-up batches reject every order: build history, trade nothing.
    if (state.warmingUp) return [];

    // 2. Exits: take profit first, then the trailing stop.
    for (const [symbol, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_bar) break;
      const s = symState(symbol);
      const c = state.close(symbol);
      if (c === null || s.entry === null || s.peak === null) continue;
      const tp = (s.entry * BigInt(10_000 + TP_BPS)) / 10_000n;
      const trail = (s.peak * BigInt(10_000 - TRAIL_BPS)) / 10_000n;
      if (c >= tp) {
        orders.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        s.entry = null;
        s.peak = null;
      } else if (c <= trail) {
        orders.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        s.entry = null;
        s.peak = null;
        s.coolUntil = state.seq + COOLDOWN_BARS;
      }
    }

    // 3. Entries: buy the dip, one symbol at a time, from cash on hand.
    // (A sell in this same reply does not fund a buy: only state.cash counts.)
    let cash = state.cash;
    for (const symbol of state.hello.symbols.map((s) => s.symbol)) {
      if (orders.length >= caps.max_orders_per_bar) break;
      if (state.positions.has(symbol)) continue;
      const s = symState(symbol);
      if (s.closes.length < WINDOW_BARS) continue;
      if (state.seq < s.coolUntil) continue;
      const c = state.close(symbol);
      if (c === null) continue;
      let high = 0n;
      for (const x of s.closes) if (x > high) high = x;
      const trigger = (high * BigInt(10_000 - DIP_BPS)) / 10_000n;
      if (c > trigger) continue;
      const room = state.weightRoom(symbol);
      let spend = (cash * BigInt(BUY_FRACTION_BPS)) / 10_000n;
      if (spend > room) spend = room;
      if (spend < minNotional) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= spend;
    }

    return orders;
  },
});
