// Pure position-risk math for Injective derivative (perpetual) positions.
// All values are in human units (exchange v2 API): price and margin in quote
// asset (e.g. USDC), quantity in base units.
//
// Formulas follow the Injective exchange module (isolated margin):
//   adjusted margin  = margin + unrealized funding
//   unrealized funding (long)  = -(cumFunding - cumFundingEntry) * qty
//   unrealized funding (short) = +(cumFunding - cumFundingEntry) * qty
//   long  liquidation price = (entry - adjMargin/qty) / (1 - MMR)
//   short liquidation price = (entry + adjMargin/qty) / (1 + MMR)
// Reference: InjectiveLabs/sdk-python examples/chain_client/10_SearchLiquidablePositions.py
// and https://docs.injective.network/developers-native/injective/exchange/00_derivative_market_concepts

export interface Position {
  subaccountId: string;
  marketId: string;
  isLong: boolean;
  quantity: number;
  entryPrice: number;
  margin: number;
  cumulativeFundingEntry: number;
}

export interface MarketRisk {
  marketId: string;
  ticker: string;
  markPrice: number;
  maintenanceMarginRatio: number;
  initialMarginRatio: number;
  cumulativeFunding: number;
  takerFeeRate: number;
  minPriceTickSize: number;
  minQuantityTickSize: number;
  minNotional: number;
  hourlyFundingRate?: number; // latest realised hourly rate (indexer)
}

export interface PositionRisk {
  position: Position;
  ticker: string;
  markPrice: number;
  adjustedMargin: number;
  unrealizedFunding: number;
  unrealizedPnl: number;
  equity: number;
  notional: number;
  effectiveLeverage: number;
  liquidationPrice: number;
  bankruptcyPrice: number;
  /** signed fraction the mark must move AGAINST the position to hit liquidation (0.1 = 10%) */
  distanceToLiquidation: number;
  liquidatable: boolean;
  /** estimated funding paid (+) or received (-) per day at the latest hourly rate, in quote */
  fundingCostPerDay: number | null;
}

export function unrealizedFunding(p: Position, cumulativeFunding: number): number {
  const delta = (cumulativeFunding - p.cumulativeFundingEntry) * p.quantity;
  return p.isLong ? -delta : delta;
}

export function adjustedMargin(p: Position, cumulativeFunding: number): number {
  return p.margin + unrealizedFunding(p, cumulativeFunding);
}

export function liquidationPrice(isLong: boolean, entry: number, adjMargin: number, qty: number, mmr: number): number {
  const unit = adjMargin / qty;
  return isLong ? (entry - unit) / (1 - mmr) : (entry + unit) / (1 + mmr);
}

export function bankruptcyPrice(isLong: boolean, entry: number, adjMargin: number, qty: number): number {
  const unit = adjMargin / qty;
  return isLong ? entry - unit : entry + unit;
}

export function pnlPerUnit(isLong: boolean, entry: number, price: number): number {
  return isLong ? price - entry : entry - price;
}

export function assessPosition(p: Position, m: MarketRisk): PositionRisk {
  const uf = unrealizedFunding(p, m.cumulativeFunding);
  const adj = p.margin + uf;
  const liq = liquidationPrice(p.isLong, p.entryPrice, adj, p.quantity, m.maintenanceMarginRatio);
  const upnl = p.quantity * pnlPerUnit(p.isLong, p.entryPrice, m.markPrice);
  const equity = adj + upnl;
  const notional = p.quantity * m.markPrice;
  const dist = p.isLong ? (m.markPrice - liq) / m.markPrice : (liq - m.markPrice) / m.markPrice;
  const liquidatable = p.isLong ? m.markPrice <= liq : m.markPrice >= liq;
  let fundingCostPerDay: number | null = null;
  if (m.hourlyFundingRate !== undefined) {
    // positive rate: longs pay shorts
    fundingCostPerDay = notional * m.hourlyFundingRate * 24 * (p.isLong ? 1 : -1);
  }
  return {
    position: p,
    ticker: m.ticker,
    markPrice: m.markPrice,
    adjustedMargin: adj,
    unrealizedFunding: uf,
    unrealizedPnl: upnl,
    equity,
    notional,
    effectiveLeverage: equity > 0 ? notional / equity : Infinity,
    liquidationPrice: liq,
    bankruptcyPrice: bankruptcyPrice(p.isLong, p.entryPrice, adj, p.quantity),
    distanceToLiquidation: dist,
    liquidatable,
    fundingCostPerDay,
  };
}

/** Per-unit margin a position needs so that its liquidation price sits at `targetLiq`. */
export function requiredUnitMargin(isLong: boolean, entry: number, targetLiq: number, mmr: number): number {
  return isLong ? entry - targetLiq * (1 - mmr) : targetLiq * (1 + mmr) - entry;
}

/** Liquidation price that is `distance` (fraction) away from mark, against the position. */
export function targetLiquidationPrice(isLong: boolean, mark: number, distance: number): number {
  return isLong ? mark * (1 - distance) : mark * (1 + distance);
}

/** Extra margin needed (quote) to move the liquidation price to `distance` away from mark. <=0 means already safe. */
export function marginToReachDistance(r: PositionRisk, mmr: number, distance: number): number {
  const p = r.position;
  const L = targetLiquidationPrice(p.isLong, r.markPrice, distance);
  return requiredUnitMargin(p.isLong, p.entryPrice, L, mmr) * p.quantity - r.adjustedMargin;
}

/**
 * Fraction f of the position to close (at `fillPrice`, net of `feeRate`) and
 * recycle the released equity back into the remaining position's margin, so that
 * the remaining position's liquidation price reaches `distance` from mark, after
 * first adding `addedMargin`. On Injective a partial close releases margin pro rata,
 * so closing alone leaves the liquidation price unchanged; recycling is what helps.
 * Returns 0 if not needed, or >1 if impossible.
 */
export function reduceFractionToReachDistance(
  r: PositionRisk, mmr: number, distance: number, addedMargin: number, fillPrice: number, feeRate: number,
): number {
  const p = r.position;
  const L = targetLiquidationPrice(p.isLong, r.markPrice, distance);
  const U = requiredUnitMargin(p.isLong, p.entryPrice, L, mmr);
  const m0 = r.adjustedMargin + addedMargin;
  const need = U * p.quantity - m0;
  if (need <= 0) return 0;
  // released per closed unit = margin/q + pnl - fee; margin/q stays with the closed unit pro rata,
  // so the gain for the remaining position per closed unit is pnl - fee + U (the U it no longer needs).
  const perUnit = pnlPerUnit(p.isLong, p.entryPrice, fillPrice) - fillPrice * feeRate + U;
  if (perUnit <= 0) return Infinity;
  return need / (p.quantity * perUnit);
}

export function roundDownToTick(x: number, tick: number): number {
  if (tick <= 0) return x;
  const n = Math.floor(x / tick + 1e-9);
  return Number((n * tick).toFixed(12));
}

export function roundUpToTick(x: number, tick: number): number {
  if (tick <= 0) return x;
  const n = Math.ceil(x / tick - 1e-9);
  return Number((n * tick).toFixed(12));
}
