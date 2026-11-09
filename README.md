# Margin Sentinel

**An AI-ready liquidation-risk agent for Injective perpetuals. This is a testnet prototype.**

Margin Sentinel reads live perpetual-market, position, orderbook, funding and insurance-fund data from Injective. For every position it computes the exact liquidation price the exchange module uses. It then simulates liquidation cascades against the *real* orderbook depth. A hard-limit policy engine proposes de-risking actions (add margin, or reduce-and-recycle) that never exceed the user's limits. It turns those proposals into the exact Injective exchange-module messages, signs them with a throwaway agent key, and asks the chain to simulate them.

It is built for the Injective Hacker House (Bangkok, Dec 2026). The plan is to grow it into an agent that runs under a scoped, time-limited AuthZ grant, plus a risk API other agents can call before they trade.

> **Testnet only.** The code asserts chain id `injective-888` before every run and has no mainnet code path. The agent key is a throwaway testnet mnemonic stored **outside the repo**. Nothing is broadcast unless you pass `--broadcast` with a funded testnet key.

## Quick start

```bash
# Node >= 22.18 (native TypeScript type-stripping). Tested on Node 24.
npm install
npm test                 # 21 unit tests (risk math, cascade, policy)
npm run demo             # full pipeline against live Injective testnet
```

Other commands:

```bash
node src/cli.ts markets                                   # perp markets + funding + open interest
node src/cli.ts scan --market "BTC/USDC PERP" --top 10    # riskiest positions in a market
node src/cli.ts cascade --market "INJ/USDC PERP" --reflexivity 0.5 --band 0.5
node src/cli.ts watch --subaccount 0x... --policy policy.example.json --balance 100
node src/cli.ts keygen                                    # throwaway testnet key -> ~/.config/margin-sentinel/testnet.key
node src/cli.ts dry-run --subaccount 0x...                # build + sign + chain-simulate the proposed tx
node src/cli.ts dry-run --order --market "ETH/USDC PERP"   # tiny reduce-only market order, signed + chain-simulated
node src/cli.ts dry-run --subaccount 0x... --broadcast    # only with a FUNDED testnet key
```

Sample output from a real run is in [`docs/demo-output.txt`](docs/demo-output.txt).

## How it uses Injective

| What | Injective interface | Code |
|---|---|---|
| Chain id / block height guard | LCD `cosmos/base/tendermint/v1beta1/node_info`, `blocks/latest` | `src/injective.ts` `assertTestnet()` |
| Perp markets: mark price, MMR/IMR, tick sizes, min notional, cumulative funding, funding cap/interval | LCD **exchange v2** `/injective/exchange/v2/derivative/markets` | `fetchPerpMarkets()` |
| All open derivative positions (qty, entry, margin, cumulative funding entry) | LCD `/injective/exchange/v2/positions` | `fetchAllPositions()` |
| Orderbook depth | LCD `/injective/exchange/v2/derivative/orderbook/{marketId}` | `fetchOrderbook()` |
| Liquidator reward share | LCD `/injective/exchange/v2/exchangeParams` | `fetchExchangeParams()` |
| Insurance-fund balance per market | LCD `/injective/insurance/v1beta1/insurance_funds` | `fetchInsuranceFunds()` |
| Realised hourly funding-rate history | **Indexer** via `@injectivelabs/sdk-ts` `IndexerGrpcDerivativesApi.fetchFundingRates` | `fetchLatestFundingRate()` |
| Add-margin and reduce-only close | `MsgIncreasePositionMargin` and `MsgCreateDerivativeMarketOrder` (exchange **v2**, reduce-only = `margin: 0`) built with `@injectivelabs/sdk-ts` | `src/orders.ts` |
| Signing + simulation + (optional) broadcast | `createTransaction`, `TxGrpcApi.simulate/broadcast` on the chain gRPC-web endpoint | `dryRun()` |
| Scoped agent permission | `MsgGrant` with `GenericAuthorization` for exactly those two v2 message types, with a 24h expiry | `buildGrant()` |

### Risk math (`src/risk.ts`)
This is Injective's isolated-margin model. Funding is applied lazily through cumulative funding.

```
unrealizedFunding = ∓ (cumulativeFunding − cumulativeFundingEntry) × qty    (long pays when positive)
adjMargin         = margin + unrealizedFunding
liq (long)        = (entry − adjMargin/qty) / (1 − MMR)
liq (short)       = (entry + adjMargin/qty) / (1 + MMR)
```

It matches InjectiveLabs' own `sdk-python` example `10_SearchLiquidablePositions.py` and the Injective docs example: 1 BTC long, entry 50,000, margin 5,000, MMR 5% gives a liquidation price of 47,368.42. Both are covered by unit tests, as is a real testnet position.

### Cascade simulation (`src/cascade.ts`)
On Injective a liquidation is a reduce-only **market** order matched against the live book at any price. The simulator works like this:
1. Apply an oracle shock.
2. Liquidate every position whose liquidation price is crossed, most underwater first.
3. Walk the real orderbook depth for each liquidation. The book doesn't refill within the scenario, so later liquidations fill worse.
4. Compute each payout (`adjMargin + realised PnL`) and the resulting **bad debt** versus the market's **insurance fund**.

`--reflexivity k` (0 to 1) models a thin or self-referential oracle that follows traded prices, so liquidations can trigger more liquidations over several rounds. Chainlink, Pyth or Stork oracles are exogenous, so the default `k = 0` means the "cascade" is book exhaustion plus insurance-fund drain. `--band` ignores stray resting orders far from the mark. Testnet books contain orders at absurd prices, and unfilled size is valued at the band edge.

### Policy engine (`src/policy.ts`)
The user sets the limits (`policy.example.json`): allowed markets, minimum and target distance to liquidation, max leverage, max add-margin per action and per day, max % reduced per action, max slippage, and a funding-carry alert. For each position it does the following:
- **HOLD** if the position is inside limits.
- **ADD_MARGIN** for exactly the amount that moves the liquidation price to the target distance, capped by the budgets and the free balance.
- **REDUCE_AND_RECYCLE** if the budget is not enough. It closes a fraction with a reduce-only market order, then re-adds the released equity as margin. On Injective a partial close releases margin pro rata, so closing alone does *not* move the liquidation price; recycling does. The fraction has a closed-form solution (`reduceFractionToReachDistance`) and is re-solved at the book-walk VWAP, including taker fees.
- **ALERT** (needs a human) if the book can't absorb the close within the slippage limit, a per-action cap is hit, the size is below min notional, or the market is outside the mandate.

An LLM layer (planned for the Hacker House) can explain and rank proposals for the user. It sits *above* this deterministic limit layer and can never bypass it.

## What the demo shows (live testnet, 9 Nov 2026)
- 8 active perp markets with open positions, about 990 positions in total. On ETH/USDC PERP, 13 of 132 positions are already past their liquidation price. Testnet has few liquidator bots, and the scan flags them.
- Cascade on ETH/USDC PERP: the bid side has only about 0.56 ETH of depth inside the ±50% band. A 20% drop liquidates 94 longs, and bad debt reaches about 2.7k USDC against a 6.7k insurance fund (2.5x cover). At 30%, 96 longs (about 145 ETH) are liquidated and bad debt is about 84k, so the fund covers only 0.1x. Unfilled size is valued at the band edge, which is deliberately conservative.
- Policy: one long at 9.0x gets an `ADD_MARGIN` of about 19 USDC, which moves its liquidation price exactly 20% away. A second needs more than the 25 USDC cap, and the thin book can't take a reduce within 1.5% slippage. The engine raises an **ALERT** instead of dumping into a bad book.
- Dry run: the agent builds the `MsgIncreasePositionMargin` (v2), signs it offline, and the **chain's simulate endpoint decodes and checks it**. With an unfunded throwaway key, the chain rejects it at the account check (`account … does not exist`), which is expected. With a funded testnet key, `--broadcast` sends it.

## Safety
- The testnet chain id is asserted before every run. There is no mainnet configuration.
- The key lives in `~/.config/margin-sentinel/testnet.key` (mode 600) or `$MS_KEY_FILE`. It is never in the repo, and `.gitignore` covers `*.key` and `.env`.
- Positions watched in the demo are other people's public testnet positions. The agent only ever builds messages for **its own** subaccount, and in production it would act for a user only through an AuthZ grant the user signs.
- Broadcasting requires `--broadcast`, an existing funded account, and a successful simulation first.

## Roadmap (Hacker House, Dec 1–10)
1. Agent loop: stream positions and markets, plus AuthZ autosign through the Injective AI Agent SDK and MCP server.
2. LLM explanations and ranking on top of the hard-limit engine.
3. A web dashboard and an on-chain action log.
4. A risk API: a signed "distance to liquidation and cascade exposure" score other agents can query before trading.
5. Mainnet only after review. Not in this prototype.

## License
MIT. See [LICENSE](LICENSE).
