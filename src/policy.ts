// Policy engine: turns a position's risk into de-risking proposals that stay
// inside user-set limits. It never acts on its own; it emits proposals plus the
// exact Injective messages that would execute them. Execution (and an LLM, if
// one is used to explain or rank proposals) sits behind this hard-limit layer.

import {
  assessPosition, marginToReachDistance, reduceFractionToReachDistance,
  roundDownToTick, roundUpToTick, liquidationPrice,
  type MarketRisk, type PositionRisk,
} from './risk.ts';
import type { Book, Level } from './cascade.ts';

export interface Policy {
  allowedMarkets: string[];          // tickers or "*"
  minLiqDistancePct: number;         // act when distance to liquidation drops below this
  targetLiqDistancePct: number;      // restore to at least this
  maxLeverage: number;               // act when effective leverage exceeds this
  maxAddMarginPerAction: number;     // quote units
  dailyAddMarginBudget: number;      // quote units
  maxReducePctPerAction: number;     // % of position size
  maxSlippagePct: number;            // worst acceptable price for reduce-only orders
  maxFundingCostPerDayPctOfEquity: number; // flag expensive carry
}

export const DEFAULT_POLICY: Policy = {
  allowedMarkets: ['*'],
  minLiqDistancePct: 10,
  targetLiqDistancePct: 20,
  maxLeverage: 8,
  maxAddMarginPerAction: 25,
  dailyAddMarginBudget: 100,
  maxReducePctPerAction: 50,
  maxSlippagePct: 1.5,
  maxFundingCostPerDayPctOfEquity: 1,
};

export interface PolicyState {
  addMarginSpentToday: number;
  availableBalance: number; // free quote balance in the agent's subaccount
}

export type Action =
  | { kind: 'HOLD'; reason: string }
  | { kind: 'ALERT'; reason: string }
  | { kind: 'ADD_MARGIN'; amount: number; reason: string }
  | { kind: 'REDUCE_AND_RECYCLE'; quantity: number; worstPrice: number; estFill: number; recycleMargin: number; reason: string };

export interface Proposal {
  risk: PositionRisk;
  actions: Action[];
  after?: { liquidationPrice: number; distancePct: number; quantity: number; margin: number };
  withinLimits: boolean;
  notes: string[];
}

export function estimateFill(levels: Level[], qty: number): { vwap: number | null; worst: number | null; filled: number } {
  let filled = 0, cost = 0, worst: number | null = null;
  for (const l of levels) {
    if (filled >= qty) break;
    const t = Math.min(l.quantity, qty - filled);
    filled += t; cost += t * l.price; worst = l.price;
  }
  return { vwap: filled > 0 ? cost / filled : null, worst, filled };
}

function allowed(policy: Policy, ticker: string): boolean {
  return policy.allowedMarkets.includes('*') || policy.allowedMarkets.includes(ticker);
}

export function propose(market: MarketRisk, risk: PositionRisk, book: Book, policy: Policy, state: PolicyState): Proposal {
  const p = risk.position;
  const mmr = market.maintenanceMarginRatio;
  const notes: string[] = [];
  const distPct = risk.distanceToLiquidation * 100;

  if (risk.fundingCostPerDay !== null && risk.equity > 0) {
    const pct = (risk.fundingCostPerDay / risk.equity) * 100;
    if (pct > policy.maxFundingCostPerDayPctOfEquity) notes.push(`funding carry ${pct.toFixed(2)}%/day of equity exceeds ${policy.maxFundingCostPerDayPctOfEquity}%`);
  }

  if (!allowed(policy, risk.ticker)) {
    return { risk, actions: [{ kind: 'ALERT', reason: `${risk.ticker} is outside the agent's mandate; alert only` }], withinLimits: true, notes };
  }
  if (risk.liquidatable) {
    notes.push('already liquidatable at current mark: liquidators may act this block');
  }
  const breachDist = distPct < policy.minLiqDistancePct;
  const breachLev = risk.effectiveLeverage > policy.maxLeverage;
  if (!breachDist && !breachLev) {
    return { risk, actions: [{ kind: 'HOLD', reason: `distance ${distPct.toFixed(2)}% >= ${policy.minLiqDistancePct}% and leverage ${risk.effectiveLeverage.toFixed(2)}x <= ${policy.maxLeverage}x` }], withinLimits: true, notes };
  }

  // Target distance: at least the policy target, and enough to bring leverage under the cap.
  // For an isolated position, equity/notional at mark = d + (1-d)*mmr (long) or d + (1+d)*mmr (short),
  // where d is the distance to liquidation, so leverage <= maxLev  <=>  d >= levDist below.
  const levDist = (1 / policy.maxLeverage - mmr) / (p.isLong ? 1 - mmr : 1 + mmr);
  const target = Math.max(policy.targetLiqDistancePct / 100, levDist);
  const need = marginToReachDistance(risk, mmr, target);
  const actions: Action[] = [];
  const budget = Math.max(0, Math.min(policy.maxAddMarginPerAction, policy.dailyAddMarginBudget - state.addMarginSpentToday, state.availableBalance));
  const add = Math.min(Math.max(0, need), budget);
  const reasonBase = breachDist ? `distance to liquidation ${distPct.toFixed(2)}% < ${policy.minLiqDistancePct}%` : `leverage ${risk.effectiveLeverage.toFixed(2)}x > ${policy.maxLeverage}x`;

  let margin = risk.adjustedMargin;
  let qty = p.quantity;
  if (add > 0) {
    const amt = Math.ceil(add * 100) / 100;
    actions.push({ kind: 'ADD_MARGIN', amount: amt, reason: `${reasonBase}; add ${amt} to move liquidation to >= ${(target * 100).toFixed(1)}% away (budget left ${budget.toFixed(2)})` });
    margin += amt;
  }
  if (need - add > 1e-9) {
    // close part of the position and recycle released equity into the remainder
    const levels = p.isLong ? book.bids : book.asks;
    let f = reduceFractionToReachDistance(risk, mmr, target, add, risk.markPrice, market.takerFeeRate);
    let est = estimateFill(levels, p.quantity * Math.min(1, f));
    if (est.vwap !== null) f = reduceFractionToReachDistance(risk, mmr, target, add, est.vwap, market.takerFeeRate);
    const cap = policy.maxReducePctPerAction / 100;
    const fCapped = Math.min(f, cap);
    let rq = roundUpToTick(p.quantity * fCapped, market.minQuantityTickSize);
    if (rq > p.quantity) rq = roundDownToTick(p.quantity, market.minQuantityTickSize);
    est = estimateFill(levels, rq);
    const worstAllowed = p.isLong ? risk.markPrice * (1 - policy.maxSlippagePct / 100) : risk.markPrice * (1 + policy.maxSlippagePct / 100);
    const worstPrice = p.isLong ? roundDownToTick(worstAllowed, market.minPriceTickSize) : roundUpToTick(worstAllowed, market.minPriceTickSize);
    const fillOk = est.filled >= rq - 1e-12 && est.worst !== null && (p.isLong ? est.worst >= worstPrice : est.worst <= worstPrice);
    if (!Number.isFinite(f) || rq <= 0) {
      actions.push({ kind: 'ALERT', reason: 'reduce-and-recycle cannot restore the target (position too far underwater); human decision needed' });
    } else if (!fillOk) {
      actions.push({ kind: 'ALERT', reason: `book cannot absorb a reduce-only close of ${rq} within ${policy.maxSlippagePct}% slippage (est. worst fill ${est.worst ?? 'none'}); human decision needed` });
    } else if (rq * (est.vwap ?? risk.markPrice) < market.minNotional) {
      actions.push({ kind: 'ALERT', reason: `required reduce ${rq} is below the market min notional ${market.minNotional}` });
    } else {
      const fill = est.vwap ?? risk.markPrice;
      const released = rq * ((p.isLong ? fill - p.entryPrice : p.entryPrice - fill) - fill * market.takerFeeRate) + margin * (rq / qty);
      actions.push({
        kind: 'REDUCE_AND_RECYCLE', quantity: rq, worstPrice, estFill: fill, recycleMargin: Math.max(0, Math.floor(released * 100) / 100),
        reason: `${f > cap ? `needs ${(f * 100).toFixed(1)}% but capped at ${policy.maxReducePctPerAction}%; ` : ''}reduce-only close ${rq} (est. fill ${fill.toFixed(4)}), then re-add released equity as margin`,
      });
      margin = margin - margin * (rq / qty) + Math.max(0, released);
      qty = qty - rq;
      if (f > cap) actions.push({ kind: 'ALERT', reason: 'per-action reduce cap reached; target not fully restored' });
    }
  }
  const liqAfter = liquidationPrice(p.isLong, p.entryPrice, margin, qty, mmr);
  const distAfter = (p.isLong ? risk.markPrice - liqAfter : liqAfter - risk.markPrice) / risk.markPrice;
  return {
    risk, actions, notes,
    withinLimits: actions.every((a) => a.kind !== 'ALERT'),
    after: { liquidationPrice: liqAfter, distancePct: distAfter * 100, quantity: qty, margin },
  };
}

export { assessPosition };
