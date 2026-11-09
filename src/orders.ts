// Turning policy proposals into Injective transactions, safely.
//  - The agent key is a THROWAWAY testnet key read from a file OUTSIDE the repo
//    (default ~/.config/margin-sentinel/testnet.key, override with MS_KEY_FILE).
//  - Default mode is a dry run: build the exchange-module messages, sign offline,
//    and ask the chain to SIMULATE the tx (no state change). Nothing is broadcast
//    unless --broadcast is passed AND the chain id is injective-888.
//  - In production the user would sign one time-limited AuthZ MsgGrant that lets the
//    agent key send only these two message types; buildGrant() prints that message.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  PrivateKey, MsgCreateDerivativeMarketOrderV2, MsgIncreasePositionMarginV2, MsgGrant,
  createTransaction, TxGrpcApi, TxClient, getGenericAuthorizationFromMessageType,
} from '@injectivelabs/sdk-ts';
import { endpoints, TESTNET_CHAIN_ID, fetchAccount, assertTestnet } from './injective.ts';
import type { Proposal } from './policy.ts';

export const KEY_FILE = process.env.MS_KEY_FILE ?? join(homedir(), '.config', 'margin-sentinel', 'testnet.key');

export function keygen(path = KEY_FILE): { address: string; path: string; created: boolean } {
  if (existsSync(path)) return { address: loadKey(path).toBech32(), path, created: false };
  const { privateKey, mnemonic } = PrivateKey.generate();
  mkdirSync(dirname(path), { recursive: true });
  // throwaway TESTNET mnemonic; never put a real key here
  writeFileSync(path, mnemonic + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return { address: privateKey.toBech32(), path, created: true };
}

export function loadKey(path = KEY_FILE): PrivateKey {
  const secret = readFileSync(path, 'utf8').trim();
  return /^(0x)?[0-9a-fA-F]{64}$/.test(secret) ? PrivateKey.fromHex(secret) : PrivateKey.fromMnemonic(secret);
}

const ORDER_TYPE_BUY = 1;
const ORDER_TYPE_SELL = 2;

export function messagesForProposal(p: Proposal, agent: PrivateKey, marketId: string): any[] {
  const addr = agent.toBech32();
  const sub = agent.toAddress().getSubaccountId(0);
  const msgs: any[] = [];
  for (const a of p.actions) {
    if (a.kind === 'ADD_MARGIN') {
      msgs.push(MsgIncreasePositionMarginV2.fromJSON({ marketId, injectiveAddress: addr, srcSubaccountId: sub, dstSubaccountId: sub, amount: a.amount.toFixed(2) }));
    } else if (a.kind === 'REDUCE_AND_RECYCLE') {
      // reduce-only market order: margin = 0, opposite side, worst acceptable price
      msgs.push(MsgCreateDerivativeMarketOrderV2.fromJSON({
        marketId, subaccountId: sub, injectiveAddress: addr, feeRecipient: addr,
        orderType: (p.risk.position.isLong ? ORDER_TYPE_SELL : ORDER_TYPE_BUY) as any,
        price: String(a.worstPrice), margin: '0', quantity: String(a.quantity),
      }));
      if (a.recycleMargin > 0) {
        msgs.push(MsgIncreasePositionMarginV2.fromJSON({ marketId, injectiveAddress: addr, srcSubaccountId: sub, dstSubaccountId: sub, amount: a.recycleMargin.toFixed(2) }));
      }
    }
  }
  return msgs;
}

export function buildGrant(granter: string, grantee: string, hours = 24): any[] {
  const types = msgTypeUrls();
  return types.map((t) => MsgGrant.fromJSON({ granter, grantee, authorization: getGenericAuthorizationFromMessageType(t), expiration: Math.floor(Date.now() / 1000) + hours * 3600 }));
}

export function msgTypeUrls(): string[] {
  const k = PrivateKey.generate().privateKey;
  const a = k.toBech32(), s = k.toAddress().getSubaccountId(0), m = '0x' + '0'.repeat(64);
  return [
    MsgCreateDerivativeMarketOrderV2.fromJSON({ marketId: m, subaccountId: s, injectiveAddress: a, feeRecipient: a, orderType: 2 as any, price: '1', margin: '0', quantity: '1' }).toDirectSign().type,
    MsgIncreasePositionMarginV2.fromJSON({ marketId: m, injectiveAddress: a, srcSubaccountId: s, dstSubaccountId: s, amount: '1' }).toDirectSign().type,
  ];
}

export const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export interface DryRunResult {
  agentAddress: string;
  chainId: string;
  messages: any[];
  txHash: string;
  bytes: number;
  simulated: { ok: boolean; gasUsed?: string; error?: string };
  broadcast?: { txHash?: string; code?: number; rawLog?: string };
}

export async function dryRun(msgs: any[], agent: PrivateKey, opts: { broadcast?: boolean; memo?: string } = {}): Promise<DryRunResult> {
  const net = await assertTestnet();
  if (net.chainId !== TESTNET_CHAIN_ID) throw new Error('not testnet');
  const address = agent.toBech32();
  const acct = await fetchAccount(address);
  const tx = createTransaction({
    message: msgs, memo: opts.memo ?? 'margin-sentinel dry-run (testnet)', chainId: TESTNET_CHAIN_ID,
    pubKey: agent.toPublicKey().toBase64(), sequence: acct?.sequence ?? 0, accountNumber: acct?.accountNumber ?? 0,
    fee: { amount: [{ denom: 'inj', amount: '64000000000000' }], gas: '400000' },
  });
  tx.txRaw.signatures = [await agent.sign(Buffer.from(tx.signBytes))];
  const api = new TxGrpcApi(endpoints.grpc);
  let simulated: DryRunResult['simulated'];
  try {
    const r: any = await api.simulate(tx.txRaw);
    simulated = { ok: true, gasUsed: String(r?.gasInfo?.gasUsed ?? '') };
  } catch (e: any) {
    simulated = { ok: false, error: String(e?.originalMessage ?? e?.message ?? e).split(' [')[0] };
  }
  const result: DryRunResult = {
    agentAddress: address, chainId: net.chainId,
    messages: msgs.map((m) => m.toAmino()),
    txHash: TxClient.hash(tx.txRaw), bytes: TxClient.encode(tx.txRaw).length,
    simulated,
  };
  if (opts.broadcast) {
    if (!acct) throw new Error(`agent account ${address} does not exist on testnet; fund it from https://testnet.faucet.injective.network/ first`);
    if (!simulated.ok) throw new Error(`refusing to broadcast: simulation failed: ${simulated.error}`);
    const r: any = await api.broadcast(tx.txRaw);
    result.broadcast = { txHash: r.txHash, code: r.code, rawLog: r.rawLog };
  }
  return result;
}
