#!/usr/bin/env node
// Margin Sentinel CLI (Injective TESTNET only).
//   node src/cli.ts demo [--market "ETH/USDC PERP"]
//   node src/cli.ts scan [--market T] [--top N]
//   node src/cli.ts cascade --market T [--reflexivity 0.5]
//   node src/cli.ts watch --subaccount 0x... [--policy policy.json]
//   node src/cli.ts keygen
//   node src/cli.ts dry-run --subaccount 0x... [--broadcast]
//   node src/cli.ts dry-run --order [--market T] [--broadcast]   (tiny reduce-only order)

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PrivateKey, MsgCreateDerivativeMarketOrderV2 } from '@injectivelabs/sdk-ts';
import {
  assertTestnet, fetchPerpMarkets, fetchAllPositions, fetchOrderbook, fetchExchangeParams,
  fetchInsuranceFunds, fetchLatestFundingRate, toMarketRisk, type RawMarket,
} from './injective.ts';
import { assessPosition, roundUpToTick, roundDownToTick, type MarketRisk, type Position, type PositionRisk } from './risk.ts';
import { simulateCascade, type Book } from './cascade.ts';
import { DEFAULT_POLICY, propose, type Policy, type Proposal } from './policy.ts';
import { keygen, loadKey, KEY_FILE, messagesForProposal, dryRun, buildGrant, bigintSafe } from './orders.ts';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'demo';
function flag(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const JSON_OUT = flag('json') === 'true';

const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d));
const short = (s: string) => `${s.slice(0, 8)}…${s.slice(34, 42)}`;
function table(rows: (string | number)[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r, j) => r.map((c, i) => String(c).padEnd(w[i])).join('  ') + (j === 0 ? '\n' + w.map((n) => '-'.repeat(n)).join('  ') : '')).join('\n');
}
const h = (t: string) => console.log(`\n=== ${t} ===`);

function loadPolicy(): Policy {
  const p = flag('policy');
  return p ? { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(p, 'utf8')) } : DEFAULT_POLICY;
}

interface Ctx {
  net: Awaited<ReturnType<typeof assertTestnet>>;
  raw: RawMarket[];
  markets: Map<string, MarketRisk>;
  positions: Position[];
  quoteDecimals: Map<string, number>;
}

async function load(): Promise<Ctx> {
  const net = await assertTestnet();
  const [raw, positions] = await Promise.all([fetchPerpMarkets(), fetchAllPositions()]);
  const markets = new Map<string, MarketRisk>();
  const quoteDecimals = new Map<string, number>();
  for (const m of raw) { markets.set(m.market.market_id, toMarketRisk(m)); quoteDecimals.set(m.market.market_id, Number(m.market.quote_decimals)); }
  return { net, raw, markets, positions: positions.filter((p) => markets.has(p.marketId) && p.quantity > 0), quoteDecimals };
}

function findMarket(ctx: Ctx, t?: string): MarketRisk {
  const want = (t ?? 'ETH/USDC PERP').toLowerCase();
  const m = [...ctx.markets.values()].find((x) => x.ticker.toLowerCase() === want || x.marketId === t);
  if (!m) throw new Error(`market ${t} not found; try: ${[...ctx.markets.values()].map((x) => x.ticker).join(', ')}`);
  return m;
}

async function withFunding(m: MarketRisk): Promise<MarketRisk> {
  const fr = await fetchLatestFundingRate(m.marketId).catch(() => null);
  return fr ? { ...m, hourlyFundingRate: fr.rate } : m;
}

function printHeader(ctx: Ctx) {
  console.log(`Margin Sentinel · Injective ${ctx.net.chainId} (app ${ctx.net.appVersion}) · block ${ctx.net.height} · ${new Date().toISOString()}`);
}

async function cmdMarkets(ctx: Ctx) {
  h('Perpetual markets (chain LCD exchange v2 + indexer funding)');
  const rows: (string | number)[][] = [['ticker', 'mark', 'MMR', 'IMR', 'hourly funding', 'positions', 'long OI', 'short OI']];
  for (const m of ctx.markets.values()) {
    const ps = ctx.positions.filter((p) => p.marketId === m.marketId);
    if (ps.length === 0) continue;
    const fr = await fetchLatestFundingRate(m.marketId).catch(() => null);
    const lo = ps.filter((p) => p.isLong).reduce((a, p) => a + p.quantity, 0);
    const so = ps.filter((p) => !p.isLong).reduce((a, p) => a + p.quantity, 0);
    rows.push([m.ticker, f(m.markPrice, 4), f(m.maintenanceMarginRatio, 4), f(m.initialMarginRatio, 4), fr ? `${(fr.rate * 100).toFixed(5)}%` : '-', ps.length, f(lo, 4), f(so, 4)]);
  }
  console.log(table(rows));
}

function riskiest(ctx: Ctx, m: MarketRisk, n: number): PositionRisk[] {
  return ctx.positions.filter((p) => p.marketId === m.marketId).map((p) => assessPosition(p, m))
    .sort((a, b) => a.distanceToLiquidation - b.distanceToLiquidation).slice(0, n);
}

function printRisk(rs: PositionRisk[]) {
  const rows: (string | number)[][] = [['subaccount', 'side', 'qty', 'entry', 'adj margin', 'uPnL', 'lev', 'liq price', 'dist %', 'funding/day', 'status']];
  for (const r of rs) rows.push([short(r.position.subaccountId), r.position.isLong ? 'LONG' : 'SHORT', f(r.position.quantity, 4), f(r.position.entryPrice, 2), f(r.adjustedMargin, 4), f(r.unrealizedPnl, 4), (r.equity <= 0 ? 'neg.eq' : f(r.effectiveLeverage, 1) + 'x'), f(r.liquidationPrice, 2), f(r.distanceToLiquidation * 100, 2), f(r.fundingCostPerDay, 4), r.liquidatable ? 'LIQUIDATABLE' : 'open']);
  console.log(table(rows));
}

async function cmdScan(ctx: Ctx) {
  const m = await withFunding(findMarket(ctx, flag('market')));
  h(`Riskiest positions in ${m.ticker} (mark ${f(m.markPrice, 4)}, MMR ${m.maintenanceMarginRatio})`);
  const rs = riskiest(ctx, m, Number(flag('top', '8')));
  printRisk(rs);
  const all = ctx.positions.filter((p) => p.marketId === m.marketId).map((p) => assessPosition(p, m));
  const liq = all.filter((r) => r.liquidatable);
  console.log(`\n${all.length} open positions; ${liq.length} already past their liquidation price at the current mark (testnet liquidator bots are sparse).`);
  return { m, rs };
}

async function cascadeFor(ctx: Ctx, m: MarketRisk): Promise<{ book: Book; down: any[]; up: any[]; fund: number | null }> {
  const [book, params, funds] = await Promise.all([fetchOrderbook(m.marketId), fetchExchangeParams(), fetchInsuranceFunds()]);
  const fr = funds.get(m.marketId);
  const fund = fr ? Number(fr.balanceRaw) / 10 ** (ctx.quoteDecimals.get(m.marketId) ?? 6) : null;
  const ps = ctx.positions.filter((p) => p.marketId === m.marketId);
  const shocks = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3];
  const k = Number(flag('reflexivity', '0'));
  const opts = { shocks, reflexivity: k, insuranceFund: fund, liquidatorRewardShare: params.liquidatorRewardShare, bandPct: Number(flag('band', '0.5')) };
  return { book, fund, down: simulateCascade(m, ps, book, { ...opts, direction: 'down' }), up: simulateCascade(m, ps, book, { ...opts, direction: 'up' }) };
}

function printCascade(label: string, steps: any[]) {
  const rows: (string | number)[][] = [['shock', 'rounds', 'final mark', '#liq', 'liq qty', 'filled', 'unfilled', 'VWAP', 'worst fill', 'bad debt', 'ins. cover']];
  for (const s of steps) rows.push([s.shockPct === 0 ? '0%' : `${label}${s.shockPct}%`, s.rounds, f(s.finalMark, 2), s.liquidatedCount, f(s.liquidatedQuantity, 4), f(s.filledQuantity, 4), f(s.unfilledQuantity, 4), f(s.vwap, 2), f(s.worstFill, 2), f(s.badDebt, 2), s.insuranceCoverage === null ? (s.badDebt > 0 ? '?' : 'n/a') : `${f(s.insuranceCoverage, 1)}x`]);
  console.log(table(rows));
}

async function cmdCascade(ctx: Ctx) {
  const m = findMarket(ctx, flag('market'));
  const c = await cascadeFor(ctx, m);
  const depth = (lv: any[]) => lv.reduce((a, l) => a + l.quantity, 0);
  h(`Liquidation cascade · ${m.ticker} · book depth bids ${f(depth(c.book.bids), 4)} / asks ${f(depth(c.book.asks), 4)} · insurance fund ${f(c.fund, 2)} · reflexivity ${flag('reflexivity', '0')}`);
  console.log('Row 0% = positions already past liquidation at the current mark (pending; testnet has few liquidator bots).');
  printCascade('-', c.down);
  console.log('');
  printCascade('+', c.up);
  console.log('bad debt = liquidation payouts below zero at the simulated fill VWAP, which the market insurance fund must cover; "ins. cover" = fund / bad debt.');
  return c;
}

function printProposal(p: Proposal) {
  const r = p.risk;
  console.log(`\n• ${short(r.position.subaccountId)} ${r.position.isLong ? 'LONG' : 'SHORT'} ${f(r.position.quantity, 4)} ${r.ticker} | liq ${f(r.liquidationPrice, 2)} (${f(r.distanceToLiquidation * 100, 2)}% away) | lev ${f(r.effectiveLeverage, 1)}x`);
  for (const a of p.actions) {
    const extra = a.kind === 'ADD_MARGIN' ? ` amount=${a.amount}` : a.kind === 'REDUCE_AND_RECYCLE' ? ` qty=${a.quantity} worstPrice=${a.worstPrice} recycle=${a.recycleMargin}` : '';
    console.log(`   → ${a.kind}${extra}: ${a.reason}`);
  }
  for (const n of p.notes) console.log(`   ! ${n}`);
  if (p.after && p.actions.some((a) => a.kind === 'ADD_MARGIN' || a.kind === 'REDUCE_AND_RECYCLE')) {
    console.log(`   after: qty ${f(p.after.quantity, 4)}, margin ${f(p.after.margin, 4)}, liq ${f(p.after.liquidationPrice, 2)} (${f(p.after.distancePct, 2)}% away) · within limits: ${p.withinLimits}`);
  }
}

async function cmdWatch(ctx: Ctx, sub?: string) {
  const policy = loadPolicy();
  const subaccount = sub ?? flag('subaccount');
  if (!subaccount) throw new Error('--subaccount 0x... required');
  const mine = ctx.positions.filter((p) => p.subaccountId.toLowerCase() === subaccount.toLowerCase());
  h(`Policy proposals for ${short(subaccount)} (${mine.length} positions)`);
  console.log(`policy: ${JSON.stringify(policy)}`);
  const out: Proposal[] = [];
  for (const p of mine) {
    const m = await withFunding(ctx.markets.get(p.marketId)!);
    const book = await fetchOrderbook(m.marketId);
    const prop = propose(m, assessPosition(p, m), book, policy, { addMarginSpentToday: 0, availableBalance: Number(flag('balance', '100')) });
    printProposal(prop);
    out.push(prop);
  }
  return out;
}

function agentKey(): { key: PrivateKey; ephemeral: boolean } {
  if (existsSync(KEY_FILE)) return { key: loadKey(), ephemeral: false };
  return { key: PrivateKey.generate().privateKey, ephemeral: true };
}

async function cmdDryRunOrder(ctx: Ctx) {
  // tiny reduce-only market SELL on the chosen market, sized to the minimum notional
  const m = findMarket(ctx, flag('market'));
  const { key, ephemeral } = agentKey();
  const qty = roundUpToTick((m.minNotional * 1.05) / m.markPrice, m.minQuantityTickSize);
  const worst = roundDownToTick(m.markPrice * 0.985, m.minPriceTickSize);
  const msg = MsgCreateDerivativeMarketOrderV2.fromJSON({
    marketId: m.marketId, subaccountId: key.toAddress().getSubaccountId(0), injectiveAddress: key.toBech32(), feeRecipient: key.toBech32(),
    orderType: 2 as any, price: String(worst), margin: '0', quantity: String(qty),
  });
  h(`Dry run · tiny reduce-only market SELL ${qty} ${m.ticker} (worst price ${worst}) · agent ${key.toBech32()}${ephemeral ? ' (ephemeral)' : ''}`);
  const res = await dryRun([msg], key, { broadcast: flag('broadcast') === 'true' });
  for (const x of res.messages) console.log(JSON.stringify(x, bigintSafe));
  console.log(`signed offline · tx hash ${res.txHash}`);
  console.log(`chain simulate: ${res.simulated.ok ? `OK, gas used ${res.simulated.gasUsed}` : `rejected by chain: ${res.simulated.error}`}`);
  if (res.broadcast) console.log(`BROADCAST (testnet): ${JSON.stringify(res.broadcast)}`);
}

async function cmdDryRun(ctx: Ctx, proposal?: Proposal) {
  if (flag('order') === 'true') return cmdDryRunOrder(ctx);
  let prop = proposal;
  if (!prop) {
    const props = await cmdWatch(ctx);
    prop = props.find((p) => p.actions.some((a) => a.kind === 'ADD_MARGIN' || a.kind === 'REDUCE_AND_RECYCLE'));
    if (!prop) { console.log('no executable action proposed; nothing to dry-run'); return; }
  }
  const { key, ephemeral } = agentKey();
  const msgs = messagesForProposal(prop, key, prop.risk.position.marketId);
  h(`Dry run · agent ${key.toBech32()}${ephemeral ? ' (ephemeral in-memory key; run keygen to persist one outside the repo)' : ` (key file ${KEY_FILE})`}`);
  console.log('NOTE: the watched position belongs to another testnet subaccount, so the messages target the agent\'s own subaccount to show the exact tx the agent would send for its user.');
  if (!prop.withinLimits) console.log('partial: only the in-limit actions are turned into messages; ALERTs are escalated to the user.');
  const res = await dryRun(msgs, key, { broadcast: flag('broadcast') === 'true' });
  for (const m of res.messages) console.log(JSON.stringify(m, bigintSafe));
  console.log(`signed offline · tx hash ${res.txHash} · ${res.bytes} base64 chars`);
  console.log(`chain simulate: ${res.simulated.ok ? `OK, gas used ${res.simulated.gasUsed}` : `rejected by chain: ${res.simulated.error}`}`);
  if (res.broadcast) console.log(`BROADCAST (testnet): ${JSON.stringify(res.broadcast)}`);
  const grant = buildGrant('inj1<user-wallet>', key.toBech32(), 24);
  console.log(`AuthZ the user would sign once (24h, only these 2 msg types): ${grant.map((g) => JSON.stringify(g.toAmino(), bigintSafe)).join('\n  ')}`);
  return res;
}

async function main() {
  if (cmd === 'keygen') {
    const k = keygen();
    console.log(`${k.created ? 'created' : 'exists'}: ${k.path} (mode 600, outside the repo)\naddress: ${k.address}\nfund it (testnet only) at https://testnet.faucet.injective.network/ to enable --broadcast`);
    return;
  }
  const ctx = await load();
  printHeader(ctx);
  if (cmd === 'markets') return cmdMarkets(ctx);
  if (cmd === 'scan') return void (await cmdScan(ctx));
  if (cmd === 'cascade') return void (await cmdCascade(ctx));
  if (cmd === 'watch') return void (await cmdWatch(ctx));
  if (cmd === 'dry-run') return void (await cmdDryRun(ctx));
  if (cmd === 'demo') {
    await cmdMarkets(ctx);
    const { m, rs } = await cmdScan(ctx);
    await cmdCascade(ctx);
    const policy = loadPolicy();
    h(`Policy engine on the riskiest open (not yet liquidatable) positions · limits ${JSON.stringify(policy)}`);
    const book = await fetchOrderbook(m.marketId);
    const open = ctx.positions.filter((p) => p.marketId === m.marketId).map((p) => assessPosition(p, m))
      .filter((r) => !r.liquidatable).sort((a, b) => a.distanceToLiquidation - b.distanceToLiquidation).slice(0, 3);
    const props = open.map((r) => propose(m, r, book, policy, { addMarginSpentToday: 0, availableBalance: Number(flag('balance', '100')) }));
    props.forEach(printProposal);
    const act = props.find((p) => p.actions.some((a) => a.kind === 'ADD_MARGIN' || a.kind === 'REDUCE_AND_RECYCLE'));
    if (act) await cmdDryRun(ctx, act);
    if (flag('save') === 'true') {
      mkdirSync('out', { recursive: true });
      writeFileSync('out/last-demo.json', JSON.stringify({ at: new Date().toISOString(), market: m, riskiest: rs, proposals: props }, bigintSafe, 2));
    }
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => { console.error(`error: ${e.message ?? e}`); process.exit(1); });
