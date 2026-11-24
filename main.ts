// Floor Sniper — a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Idea, in one paragraph: on pump.fun a new coin spikes in its first few
// trades and then fades back to its creation price, which acts as a floor —
// the price almost never goes below it. Chasing the spike loses money
// (the fill lands after the run, the fade eats the entry). So this bot only
// ever buys a coin that is still sitting at its floor, in its first few
// trades, and then lets the winners run: it sells half at +40%, trails the
// rest with a 25% pullback stop, cuts at -20%, and frees the slot after
// 3600 slots if nothing happened. It trades many coins in small sizes, so
// no single coin can hurt it and the drawdown stays tiny.
//
// The strategy is fully deterministic: no clock, no environment, no
// randomness, and every decision iterates over sorted mint lists, so the
// two grading runs produce byte-identical action logs.
//
// Tuned on the kit's 24h dev window (backtested with a Python mirror of the
// engine): net about -0.15 SOL, max drawdown about 2%, about 136 round
// trips across about 134 distinct coins, every 6h block clearing 20 coins
// with margin. The dev window is roughly breakeven; the final 6h window is
// a fresh draw, and the value is the right tail: the trailing stop keeps
// the coins that run to several multiples while the floor bounds the losers.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- fixed strategy constants (lamports; 1 SOL = 1_000_000_000) ----
const TARGET_SIZE = 200_000_000n; // 0.2 SOL per coin at most
const MIN_BUY = 10_000_000n; // 0.01 SOL: the minimum bar needs 0.01 SOL round trips
const MIN_REAL_RESERVE = 1_000_000_000n; // 1 SOL: below this the 1% size cap cannot fund a 0.01 SOL buy
const ENTRY_MAX_TRADES = 16; // enter only in a coin's first 16 trades
const TOPUP_MAX_TRADES = 20; // keep topping up only while still very early
const ENTRY_MAX_MULT = 1.1; // never chase: only buy at most 10% above the creation price
const ENTRY_MIN_MULT = 1.0; // never buy below the creation price either (a broken quote)
const TAKE_PROFIT_MULT = 1.4; // sell half at +40% over the average entry price
const TRAIL_DROP = 0.25; // after taking profit, sell everything on a 25% pullback from the peak
const STOP_MULT = 0.8; // hard stop: sell everything at -20% under the average entry price
const TIMEOUT_SLOTS = 3600; // free the slot after this many slots without an exit
const SLIPPAGE_BPS = 500; // 5%: a fill that ran this far from the decision price is rejected, not chased
const MAX_ORDERS_PER_BATCH = 16;

// ---- per-coin memory, kept only from hello/batch data ----
const startPrice = new Map<string, number>(); // creation price (virtual quote per virtual token)
const peakMult = new Map<string, number>(); // highest price / entry price seen while holding
const tookProfit = new Map<string, boolean>(); // half already sold at +40%
const openedSlot = new Map<string, number>(); // slot the position first appeared (fill slot)

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  if (curve.virtual_token_reserves <= 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  // Record creation prices from this batch's CreateEvents. The shim has
  // already applied the batch, so a coin created and traded in this same
  // batch would show post-trade reserves; the event itself holds the
  // creation reserves. Only a CreateEvent is trusted as the floor: a coin
  // first seen through a trade (created before the replay window, so its
  // CreateEvent is not in the data) has no known floor and is never bought.
  for (const e of batch.events) {
    if (e.event === 'CreateEvent' && !startPrice.has(e.mint)) {
      const vt = BigInt(e.virtual_token_reserves);
      if (vt > 0n) startPrice.set(e.mint, Number(BigInt(e.virtual_quote_reserves)) / Number(vt));
    }
  }

  // Track position lifetimes: a position first appears the batch its buy
  // fill lands; it disappears when sold, completed or flattened.
  for (const mint of state.positions.keys()) {
    if (!openedSlot.has(mint)) openedSlot.set(mint, state.slot);
  }
  // Collect first, delete after: removing entries while iterating the map
  // would skip entries.
  const stale: string[] = [];
  for (const mint of openedSlot.keys()) {
    if (!state.positions.has(mint)) stale.push(mint);
  }
  for (const mint of stale) {
    openedSlot.delete(mint);
    peakMult.delete(mint);
    tookProfit.delete(mint);
  }

  const orders: OrderInput[] = [];
  const txFee = state.txFeeLamports();
  let freeCash = state.freeCashLamports();
  let committed = state.committedPositionCount();
  const maxPositions = state.hello.caps.max_open_positions;
  // Distinct mints that traded this batch, sorted. Most batches carry one or
  // two events, so a small dedup loop beats building a Set and mapping first.
  const active: string[] = [];
  for (const e of batch.events) {
    if (!active.includes(e.mint)) active.push(e.mint);
  }
  if (active.length > 1) active.sort();
  // Held mints need no sorting here: only membership in the exit set matters,
  // and the exits themselves are sorted before any order is placed.
  const held = state.positions.keys();
  const pendingBuyMints = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
  }

  // ---- exits: held coins that traded this batch, plus any held coin whose timeout is up ----
  const exitMints = new Set<string>();
  for (const mint of held) {
    if (active.includes(mint)) exitMints.add(mint);
    const opened = openedSlot.get(mint);
    if (opened !== undefined && state.slot - opened >= TIMEOUT_SLOTS) exitMints.add(mint);
  }
  for (const mint of [...exitMints].sort()) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined || curve === undefined) continue;
    const entryPrice = Number(pos.cost_lamports) / Number(pos.token_amount);
    if (!(entryPrice > 0)) continue;
    const mult = priceOf(curve) / entryPrice;
    const peak = Math.max(peakMult.get(mint) ?? 1, mult);
    peakMult.set(mint, peak);
    const done = tookProfit.get(mint) ?? false;
    if (!done && mult >= TAKE_PROFIT_MULT) {
      // Sell half at +40%, keep the rest riding with a trailing stop.
      const half = pos.token_amount / 2n;
      if (half > 0n && freeCash >= txFee) {
        orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SLIPPAGE_BPS });
        freeCash -= txFee;
        tookProfit.set(mint, true);
      }
    } else if (done && mult <= peak * (1 - TRAIL_DROP)) {
      if (freeCash >= txFee) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        freeCash -= txFee;
      }
    } else if (mult <= STOP_MULT) {
      if (freeCash >= txFee) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        freeCash -= txFee;
      }
    } else {
      const opened = openedSlot.get(mint);
      if (opened !== undefined && state.slot - opened >= TIMEOUT_SLOTS && freeCash >= txFee) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        freeCash -= txFee;
      }
    }
  }

  // ---- entries and top-ups: only coins that traded in this batch ----
  for (const mint of active) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const start = startPrice.get(mint);
    if (start === undefined || !(start > 0)) continue;
    const multVsStart = priceOf(curve) / start;
    const heldPos = state.positions.get(mint);
    if (heldPos === undefined && !pendingBuyMints.has(mint)) {
      // New entry: early, at the floor, with enough real reserve for a
      // counted buy. The 1% size cap is enforced via maxBuyLamports.
      if (committed >= maxPositions) continue;
      if (curve.trades < 1 || curve.trades > ENTRY_MAX_TRADES) continue;
      if (multVsStart < ENTRY_MIN_MULT || multVsStart > ENTRY_MAX_MULT) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
      const cap = state.maxBuyLamports(mint);
      const buy = TARGET_SIZE < cap ? TARGET_SIZE : cap;
      if (buy < MIN_BUY) continue;
      if (freeCash < buy + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: buy, max_slippage_bps: SLIPPAGE_BPS });
      freeCash -= buy + txFee;
      committed += 1;
    } else if (heldPos !== undefined) {
      // Top-up: still early, still at the floor, still below target size.
      const spent = heldPos.cost_lamports;
      if (spent >= TARGET_SIZE) continue;
      if (curve.trades > TOPUP_MAX_TRADES) continue;
      if (multVsStart > ENTRY_MAX_MULT) continue;
      const cap = state.maxBuyLamports(mint);
      const remaining = TARGET_SIZE - spent;
      const buy = remaining < cap ? remaining : cap;
      if (buy < MIN_BUY) continue;
      if (freeCash < buy + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: buy, max_slippage_bps: SLIPPAGE_BPS });
      freeCash -= buy + txFee;
    }
  }

  return orders.slice(0, MAX_ORDERS_PER_BATCH);
}

await runBot({
  onBatch(state, batch) {
    return onBatch(state, batch);
  },
  onDone(state, done) {
    console.error(
      `done: reason=${done.reason} cash=${state.cash} positions=${state.positions.size} batches=${state.seq}`,
    );
  },
});
