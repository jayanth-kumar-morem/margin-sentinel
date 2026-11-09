import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustedMargin, liquidationPrice, assessPosition, marginToReachDistance,
  reduceFractionToReachDistance, roundDownToTick, roundUpToTick, type MarketRisk, type Position,
} from '../src/risk.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const market = (o: Partial<MarketRisk> = {}): MarketRisk => ({
  marketId: '0xm', ticker: 'BTC/USDC PERP', markPrice: 50000, maintenanceMarginRatio: 0.05, initialMarginRatio: 0.1,
  cumulativeFunding: 0, takerFeeRate: 0, minPriceTickSize: 0.1, minQuantityTickSize: 0.0001, minNotional: 1, ...o,
});
const pos = (o: Partial<Position> = {}): Position => ({
  subaccountId: '0xs', marketId: '0xm', isLong: true, quantity: 1, entryPrice: 50000, margin: 5000, cumulativeFundingEntry: 0, ...o,
});

test('Injective API docs example: 1 BTC long, entry 50k, margin 5k, MMR 5% -> liq 47,368.42', () => {
  close(liquidationPrice(true, 50000, 5000, 1, 0.05), 47368.42105263, 1e-6);
});

test('short liquidation price mirrors long', () => {
  close(liquidationPrice(false, 50000, 5000, 1, 0.05), 55000 / 1.05);
});

test('funding: longs pay when cumulative funding rises, shorts receive', () => {
  const p = pos({ quantity: 2, margin: 100, cumulativeFundingEntry: 5 });
  close(adjustedMargin(p, 8), 100 - 6);
  close(adjustedMargin({ ...p, isLong: false }, 8), 100 + 6);
});

test('real testnet sample (ETH/USDC PERP) matches hand calculation', () => {
  // values read from injective-888 LCD /injective/exchange/v2/positions on 2026-11-09
  const p = pos({ quantity: 0.0208, entryPrice: 1917, margin: 4.075137608042422, cumulativeFundingEntry: 5.188276323241578 });
  const m = market({ maintenanceMarginRatio: 0.01, cumulativeFunding: 38.74851273147518, markPrice: 2122.32 });
  const r = assessPosition(p, m);
  const adj = 4.075137608042422 - 0.0208 * (38.74851273147518 - 5.188276323241578);
  close(r.adjustedMargin, adj);
  close(r.liquidationPrice, (1917 - adj / 0.0208) / 0.99);
  assert.equal(r.liquidatable, false);
});

test('liquidatable flag flips exactly at the liquidation price', () => {
  const p = pos();
  const liq = liquidationPrice(true, 50000, 5000, 1, 0.05);
  assert.equal(assessPosition(p, market({ markPrice: liq + 0.01 })).liquidatable, false);
  assert.equal(assessPosition(p, market({ markPrice: liq - 0.01 })).liquidatable, true);
});

test('marginToReachDistance lands liquidation exactly at the target distance', () => {
  const p = pos({ margin: 3000 });
  const m = market({ markPrice: 49000 });
  const r = assessPosition(p, m);
  const add = marginToReachDistance(r, 0.05, 0.2);
  const liq = liquidationPrice(true, 50000, r.adjustedMargin + add, 1, 0.05);
  close((49000 - liq) / 49000, 0.2);
});

test('reduce-and-recycle fraction restores target distance (long and short)', () => {
  for (const isLong of [true, false]) {
    const p = pos({ isLong, margin: 3000, entryPrice: 50000 });
    const mark = isLong ? 51000 : 49000; // position in profit
    const m = market({ markPrice: mark, takerFeeRate: 0.0005 });
    const r = assessPosition(p, m);
    const fr = reduceFractionToReachDistance(r, 0.05, 0.15, 0, mark, 0.0005);
    assert.ok(fr > 0 && fr < 1, `fraction ${fr}`);
    const closedQ = p.quantity * fr;
    const pnl = (isLong ? mark - 50000 : 50000 - mark) - mark * 0.0005;
    const newMargin = r.adjustedMargin + closedQ * pnl;
    const liq = liquidationPrice(isLong, 50000, newMargin, p.quantity - closedQ, 0.05);
    close(Math.abs(liq - mark) / mark, 0.15, 1e-9);
  }
});

test('reduce fraction is 0 when already safe', () => {
  const r = assessPosition(pos({ margin: 20000 }), market());
  assert.equal(reduceFractionToReachDistance(r, 0.05, 0.1, 0, 50000, 0), 0);
});

test('tick rounding', () => {
  assert.equal(roundDownToTick(0.12345, 0.0001), 0.1234);
  assert.equal(roundUpToTick(0.12341, 0.0001), 0.1235);
  assert.equal(roundDownToTick(2090.17, 0.1), 2090.1);
});
