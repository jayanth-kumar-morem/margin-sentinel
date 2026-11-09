// Read-only access to Injective TESTNET.
//  - Chain state via the LCD REST API, exchange module v2 (human-readable decimals).
//  - Indexer via the official TS SDK (@injectivelabs/sdk-ts, gRPC-web) for funding-rate
//    history and subaccount balances.
// Mainnet is deliberately not supported: TESTNET_CHAIN_ID is asserted before use.

import { IndexerGrpcDerivativesApi, IndexerGrpcAccountApi } from '@injectivelabs/sdk-ts';
import { getNetworkEndpoints, Network } from '@injectivelabs/networks';
import type { MarketRisk, Position } from './risk.ts';
import type { Book } from './cascade.ts';

export const TESTNET_CHAIN_ID = 'injective-888';
export const endpoints = getNetworkEndpoints(Network.Testnet);
const LCD = process.env.MS_LCD ?? endpoints.rest;
const EX = `${LCD}/injective/exchange/v2`;

async function getJson(url: string, timeoutMs = 30000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

export async function assertTestnet(): Promise<{ chainId: string; appVersion: string; height: string }> {
  const info = await getJson(`${LCD}/cosmos/base/tendermint/v1beta1/node_info`);
  const chainId = info.default_node_info?.network;
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`refusing to run: expected ${TESTNET_CHAIN_ID}, endpoint reports ${chainId}`);
  const blk = await getJson(`${LCD}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  return { chainId, appVersion: info.application_version?.version ?? '?', height: blk.block?.header?.height ?? '?' };
}

export interface RawMarket {
  market: any;
  perpetual_info?: any;
  mark_price: string;
  mid_price_and_tob?: any;
}

export function toMarketRisk(m: RawMarket): MarketRisk {
  const mk = m.market;
  return {
    marketId: mk.market_id,
    ticker: mk.ticker,
    markPrice: Number(m.mark_price),
    maintenanceMarginRatio: Number(mk.maintenance_margin_ratio),
    initialMarginRatio: Number(mk.initial_margin_ratio),
    cumulativeFunding: Number(m.perpetual_info?.funding_info?.cumulative_funding ?? 0),
    takerFeeRate: Number(mk.taker_fee_rate),
    minPriceTickSize: Number(mk.min_price_tick_size),
    minQuantityTickSize: Number(mk.min_quantity_tick_size),
    minNotional: Number(mk.min_notional),
  };
}

export async function fetchPerpMarkets(): Promise<RawMarket[]> {
  const d = await getJson(`${EX}/derivative/markets?status=Active&with_mid_price_and_tob=true`);
  return (d.markets as RawMarket[]).filter((m) => m.market.isPerpetual);
}

export async function fetchAllPositions(): Promise<Position[]> {
  const d = await getJson(`${EX}/positions`, 60000);
  return (d.state as any[]).map((s) => ({
    subaccountId: s.subaccount_id,
    marketId: s.market_id,
    isLong: Boolean(s.position.isLong),
    quantity: Number(s.position.quantity),
    entryPrice: Number(s.position.entry_price),
    margin: Number(s.position.margin),
    cumulativeFundingEntry: Number(s.position.cumulative_funding_entry),
  }));
}

export async function fetchOrderbook(marketId: string, limit = 200): Promise<Book> {
  const d = await getJson(`${EX}/derivative/orderbook/${marketId}?limit=${limit}`);
  const conv = (xs: any[] = []) => xs.map((l) => ({ price: Number(l.p), quantity: Number(l.q) }));
  return { bids: conv(d.buys_price_level), asks: conv(d.sells_price_level) };
}

export async function fetchExchangeParams(): Promise<{ liquidatorRewardShare: number }> {
  const d = await getJson(`${EX}/exchangeParams`);
  return { liquidatorRewardShare: Number(d.params.liquidator_reward_share_rate) };
}

/** Insurance fund balance per market id, in human quote units (uses denom decimals from quote_decimals). */
export async function fetchInsuranceFunds(): Promise<Map<string, { balanceRaw: string; denom: string }>> {
  const d = await getJson(`${LCD}/injective/insurance/v1beta1/insurance_funds`);
  const out = new Map<string, { balanceRaw: string; denom: string }>();
  for (const f of d.funds ?? []) out.set(f.market_id, { balanceRaw: f.balance, denom: f.deposit_denom });
  return out;
}

const derivativesApi = new IndexerGrpcDerivativesApi(endpoints.indexer);
const accountApi = new IndexerGrpcAccountApi(endpoints.indexer);

/** Latest realised hourly funding rate for a market (indexer). */
export async function fetchLatestFundingRate(marketId: string): Promise<{ rate: number; timestamp: number } | null> {
  const r = await derivativesApi.fetchFundingRates({ marketId, pagination: { limit: 1 } as any });
  const x = r.fundingRates?.[0];
  return x ? { rate: Number(x.rate), timestamp: Number(x.timestamp) } : null;
}

export async function fetchSubaccountBalances(subaccountId: string): Promise<any[]> {
  try { return await accountApi.fetchSubaccountBalancesList(subaccountId); } catch { return []; }
}

export async function fetchAccount(address: string): Promise<{ accountNumber: number; sequence: number } | null> {
  try {
    const d = await getJson(`${LCD}/cosmos/auth/v1beta1/accounts/${address}`);
    const a = d.account?.base_account ?? d.account;
    return { accountNumber: Number(a.account_number), sequence: Number(a.sequence ?? 0) };
  } catch {
    return null;
  }
}

export async function fetchBankBalances(address: string): Promise<any[]> {
  try { return (await getJson(`${LCD}/cosmos/bank/v1beta1/balances/${address}`)).balances ?? []; } catch { return []; }
}

export { LCD };
