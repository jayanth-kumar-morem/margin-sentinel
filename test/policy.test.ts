import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose, DEFAULT_POLICY } from '../src/policy.ts';
import { assessPosition, type MarketRisk, type Position } from '../src/risk.ts';
import type { Book } from '../src/cascade.ts';

const m: MarketRisk = { marketId: '0xm', ticker: 'ETH/USDC PERP', markPrice: 2000, maintenanceMarginRatio: 0.01, initialMarginRatio: 0.02, cumulativeFunding: 0, takerFeeRate: 0.0005, minPriceTickSize: 0.1, minQuantityTickSize: 0.0001, minNotional: 1 };
const p = (margin: number, isLong = true, qty = 0.1): Position => ({ subaccountId: '0xs', marketId: '0xm', isLong, quantity: qty, entryPrice: 2000, margin, cumulativeFundingEntry: 0 });
const deepBook: Book = { bids: [{ price: 1999, quantity: 10 }], asks: [{ price: 2001, quantity: 10 }] };
const state = { addMarginSpentToday: 0, availableBalance: 1000 };

test('healthy position -> HOLD', () => {
  const r = assessPosition(p(100), m);
  const out = propose(m, r, deepBook, DEFAULT_POLICY, state);
  assert.equal(out.actions[0].kind, 'HOLD');
});

test('thin margin within budget -> ADD_MARGIN that restores the target', () => {
  const r = assessPosition(p(10), m); // 20x
  const out = propose(m, r, deepBook, DEFAULT_POLICY, state);
  assert.equal(out.actions[0].kind, 'ADD_MARGIN');
  assert.ok(out.withinLimits);
  assert.ok(out.after!.distancePct >= DEFAULT_POLICY.targetLiqDistancePct - 1e-6);
});

test('budget exhausted -> REDUCE_AND_RECYCLE on a deep book, still within limits', () => {
  const r = assessPosition(p(10), m);
  const out = propose(m, r, deepBook, { ...DEFAULT_POLICY, maxAddMarginPerAction: 5, maxReducePctPerAction: 90 }, state);
  const kinds = out.actions.map((a) => a.kind);
  assert.deepEqual(kinds, ['ADD_MARGIN', 'REDUCE_AND_RECYCLE']);
  assert.ok(out.after!.distancePct >= DEFAULT_POLICY.targetLiqDistancePct - 0.5, `after ${out.after!.distancePct}`);
});

test('thin book -> ALERT instead of a high-slippage close', () => {
  const r = assessPosition(p(10), m);
  const thin: Book = { bids: [{ price: 1800, quantity: 10 }], asks: [] };
  const out = propose(m, r, thin, { ...DEFAULT_POLICY, maxAddMarginPerAction: 1 }, state);
  assert.ok(out.actions.some((a) => a.kind === 'ALERT'));
  assert.equal(out.withinLimits, false);
});

test('reduce cap is enforced', () => {
  const r = assessPosition(p(2), m); // ~100x
  const out = propose(m, r, deepBook, { ...DEFAULT_POLICY, maxAddMarginPerAction: 0, maxReducePctPerAction: 10 }, { ...state, availableBalance: 0 });
  const red = out.actions.find((a) => a.kind === 'REDUCE_AND_RECYCLE');
  assert.ok(red && red.kind === 'REDUCE_AND_RECYCLE' && red.quantity <= 0.1 * 0.1 + 1e-4);
  assert.ok(out.actions.some((a) => a.kind === 'ALERT'));
});

test('market outside mandate -> ALERT only', () => {
  const r = assessPosition(p(10), m);
  const out = propose(m, r, deepBook, { ...DEFAULT_POLICY, allowedMarkets: ['BTC/USDC PERP'] }, state);
  assert.deepEqual(out.actions.map((a) => a.kind), ['ALERT']);
});

test('short side works symmetrically', () => {
  const r = assessPosition(p(10, false), m);
  const out = propose(m, r, deepBook, DEFAULT_POLICY, state);
  assert.equal(out.actions[0].kind, 'ADD_MARGIN');
  assert.ok(out.after!.liquidationPrice > m.markPrice);
});
