// Liquidation-cascade simulation over real Injective orderbook depth.
//
// Model (per market, one direction at a time):
//  1. Apply an oracle/mark shock s (e.g. -5%).
//  2. Every position whose liquidation price is crossed is liquidated. On Injective a
//     liquidation is a reduce-only MARKET order matched against the live book at any price.
//  3. Liquidation orders consume book depth in order (most underwater first). The book
//     is not refilled inside the simulated block, so later liquidations fill worse.
//  4. Payout = adjusted margin + realised PnL at the fill VWAP. A negative payout is
//     bad debt that the market's insurance fund must cover.
//  5. Optional reflexivity k in [0,1]: if the oracle partly follows the traded price
//     (thin or self-referential oracle), the mark moves by k * (fill slippage) and the
//     loop repeats until no new position is liquidated.
// With k = 0 (the default) the oracle is exogenous, which is the correct assumption for
// Chainlink / Pyth / Stork-priced markets: the "cascade" is then book exhaustion +
// insurance-fund drain rather than a price spiral.

import { assessPosition, type MarketRisk, type Position } from './risk.ts';

export interface Level { price: number; quantity: number }
export interface Book { bids: Level[]; asks: Level[] }

export interface CascadeStep {
  shockPct: number;
  rounds: number;
  finalMark: number;
  liquidatedCount: number;
  liquidatedQuantity: number;
  liquidatedNotional: number;
  filledQuantity: number;
  unfilledQuantity: number;
  vwap: number | null;
  worstFill: number | null;
  badDebt: number;
  insuranceFund: number | null;
  insuranceCoverage: number | null; // fund / badDebt
  liquidatorRewards: number;
}

export interface CascadeOptions {
  shocks: number[];          // e.g. [0.01, 0.02, 0.05, 0.1]
  direction: 'down' | 'up';  // down hurts longs, up hurts shorts
  reflexivity?: number;      // 0..1
  insuranceFund?: number | null;
  liquidatorRewardShare?: number; // exchange param liquidator_reward_share_rate
  maxRounds?: number;
  /** ignore resting orders further than this fraction from the pre-shock mark (testnet books carry
   * stray orders at absurd prices). Unfilled liquidation size is valued at the band edge. Default 0.5 */
  bandPct?: number;
}

function sweep(levels: Level[], qty: number): { filled: number; cost: number; worst: number | null } {
  let filled = 0, cost = 0, worst: number | null = null;
  for (const lvl of levels) {
    if (filled >= qty) break;
    if (lvl.quantity <= 0) continue;
    const take = Math.min(lvl.quantity, qty - filled);
    lvl.quantity -= take;
    filled += take;
    cost += take * lvl.price;
    worst = lvl.price;
  }
  return { filled, cost, worst };
}

export function simulateCascade(market: MarketRisk, positions: Position[], book: Book, opt: CascadeOptions): CascadeStep[] {
  const k = opt.reflexivity ?? 0;
  const share = opt.liquidatorRewardShare ?? 0;
  const maxRounds = opt.maxRounds ?? 20;
  const victims = positions.filter((p) => (opt.direction === 'down' ? p.isLong : !p.isLong) && p.quantity > 0);
  const out: CascadeStep[] = [];

  for (const s of opt.shocks) {
    // fresh copy of the book for every scenario
    const band = opt.bandPct ?? 0.5;
    const lo = market.markPrice * (1 - band), hi = market.markPrice * (1 + band);
    const levels: Level[] = (opt.direction === 'down' ? book.bids : book.asks)
      .filter((l) => l.price >= lo && l.price <= hi).map((l) => ({ ...l }));
    const edge = opt.direction === 'down' ? lo : hi;
    let mark = opt.direction === 'down' ? market.markPrice * (1 - s) : market.markPrice * (1 + s);
    const done = new Set<number>();
    let rounds = 0, liqCount = 0, liqQty = 0, liqNotional = 0, filledQty = 0, unfilled = 0, cost = 0, badDebt = 0, rewards = 0;
    let worst: number | null = null;

    while (rounds < maxRounds) {
      const m = { ...market, markPrice: mark };
      const hit = victims
        .map((p, i) => ({ p, i, r: assessPosition(p, m) }))
        .filter((x) => !done.has(x.i) && x.r.liquidatable)
        // most underwater first: lowest equity relative to notional
        .sort((a, b) => a.r.equity / a.r.notional - b.r.equity / b.r.notional);
      if (hit.length === 0) break;
      rounds++;
      for (const { p, i, r } of hit) {
        done.add(i);
        liqCount++;
        liqQty += p.quantity;
        liqNotional += p.quantity * mark;
        const f = sweep(levels, p.quantity);
        filledQty += f.filled;
        unfilled += p.quantity - f.filled;
        cost += f.cost;
        if (f.worst !== null) worst = f.worst;
        // unfilled remainder (book exhausted inside the band) is valued at the band edge
        const fillPx = (f.cost + (p.quantity - f.filled) * edge) / p.quantity;
        const pnl = (p.isLong ? fillPx - p.entryPrice : p.entryPrice - fillPx) * p.quantity;
        const payout = r.adjustedMargin + pnl;
        if (payout < 0) badDebt += -payout; else rewards += payout * share;
      }
      if (k <= 0 || worst === null) break;
      // oracle partially follows the worst traded price
      const moved = mark + k * (worst - mark);
      if (opt.direction === 'down' ? moved >= mark : moved <= mark) break;
      mark = moved;
    }
    const fund = opt.insuranceFund ?? null;
    out.push({
      shockPct: s * 100,
      rounds,
      finalMark: mark,
      liquidatedCount: liqCount,
      liquidatedQuantity: liqQty,
      liquidatedNotional: liqNotional,
      filledQuantity: filledQty,
      unfilledQuantity: unfilled,
      vwap: filledQty > 0 ? cost / filledQty : null,
      worstFill: worst,
      badDebt,
      insuranceFund: fund,
      insuranceCoverage: fund !== null && badDebt > 0 ? fund / badDebt : null,
      liquidatorRewards: rewards,
    });
  }
  return out;
}

/** Smallest shock (from the grid) at which a given position is liquidated, or null. */
export function shockToLiquidate(market: MarketRisk, p: Position): number {
  const r = assessPosition(p, market);
  return Math.max(0, r.distanceToLiquidation);
}
