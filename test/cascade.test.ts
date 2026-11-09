import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateCascade, type Book } from '../src/cascade.ts';
import type { MarketRisk, Position } from '../src/risk.ts';

const m: MarketRisk = { marketId: '0xm', ticker: 'T', markPrice: 100, maintenanceMarginRatio: 0.05, initialMarginRatio: 0.1, cumulativeFunding: 0, takerFeeRate: 0, minPriceTickSize: 0.01, minQuantityTickSize: 0.01, minNotional: 1 };
const long = (q: number, margin: number): Position => ({ subaccountId: 's' + q + margin, marketId: '0xm', isLong: true, quantity: q, entryPrice: 100, margin, cumulativeFundingEntry: 0 });
// liq price for long entry 100, margin m, q=1, mmr .05: (100 - m)/0.95
const book = (): Book => ({ bids: [{ price: 95, quantity: 1 }, { price: 90, quantity: 1 }, { price: 80, quantity: 10 }], asks: [] });

test('no liquidations at 0% shock when everyone is healthy', () => {
  const [s] = simulateCascade(m, [long(1, 20)], book(), { shocks: [0], direction: 'down' });
  assert.equal(s.liquidatedCount, 0);
  assert.equal(s.badDebt, 0);
});

test('shock liquidates the thin-margin position and walks the book', () => {
  // margin 6 -> liq 98.95 ; margin 12 -> liq 92.63 ; margin 30 -> liq 73.7
  const ps = [long(1, 6), long(1, 12), long(1, 30)];
  const [s5, s10] = simulateCascade(m, ps, book(), { shocks: [0.05, 0.1], direction: 'down', insuranceFund: 1 });
  assert.equal(s5.liquidatedCount, 1);
  assert.equal(s5.vwap, 95); // first bid level
  assert.equal(s5.badDebt, 0); // payout 6 - 5 = 1 > 0
  assert.equal(s10.liquidatedCount, 2);
  // second liquidation fills at 90: payout 12 - 10 = 2; first at 95: payout 1 -> no bad debt
  assert.equal(s10.badDebt, 0);
});

test('book exhaustion creates bad debt and insurance coverage ratio', () => {
  const thin: Book = { bids: [{ price: 99, quantity: 0.5 }, { price: 50, quantity: 5 }], asks: [] };
  const [s] = simulateCascade(m, [long(1, 6)], thin, { shocks: [0.02], direction: 'down', insuranceFund: 10 });
  // fills 0.5@99 + 0.5@50 -> vwap 74.5 -> pnl -25.5, payout -19.5
  assert.equal(s.liquidatedCount, 1);
  assert.ok(Math.abs(s.badDebt - 19.5) < 1e-9);
  assert.ok(Math.abs((s.insuranceCoverage ?? 0) - 10 / 19.5) < 1e-9);
});

test('reflexivity propagates the cascade to the next position', () => {
  const ps = [long(1, 6), long(1, 12)];
  const b: Book = { bids: [{ price: 85, quantity: 1 }, { price: 84, quantity: 5 }], asks: [] };
  const [noReflex] = simulateCascade(m, ps, b, { shocks: [0.02], direction: 'down', reflexivity: 0 });
  const [reflex] = simulateCascade(m, ps, b, { shocks: [0.02], direction: 'down', reflexivity: 1 });
  assert.equal(noReflex.liquidatedCount, 1);
  assert.equal(reflex.liquidatedCount, 2);
  assert.ok(reflex.rounds >= 2);
});

test('up shocks only hit shorts', () => {
  const short: Position = { ...long(1, 6), isLong: false };
  const [s] = simulateCascade(m, [long(1, 6), short], { bids: [], asks: [{ price: 103, quantity: 5 }] }, { shocks: [0.05], direction: 'up' });
  assert.equal(s.liquidatedCount, 1);
});
