import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { createPayerAgent } from '../agent.js';
import { proofMessage } from '../proof.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FACTORY = '0xf00d000000000000000000000000000000000000';
const USDC = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const cfg = { rpcUrl: 'http://127.0.0.1:8545', chainId: 31337, stakeVaultFactory: FACTORY, usdc: USDC } as const;

describe('createPayerAgent account injection (browser-extension prerequisite)', () => {
  it('uses an injected viem account as the payer (no raw key)', () => {
    const account = privateKeyToAccount(KEY);
    const agent = createPayerAgent({ ...cfg, account });
    expect(agent.payer).toBe(account.address);
  });

  it('still accepts a raw payerKey (backward compatible)', () => {
    const agent = createPayerAgent({ ...cfg, payerKey: KEY });
    expect(agent.payer).toBe(privateKeyToAccount(KEY).address);
  });

  it('throws when neither account nor payerKey is given', () => {
    expect(() => createPayerAgent({ ...cfg })).toThrow(/account.*payerKey/);
  });

  it('signs the access proof with the injected account (recoverable offline)', async () => {
    const account = privateKeyToAccount(KEY);
    const agent = createPayerAgent({ ...cfg, account });
    const proof = await agent.signAccessProof();
    const recovered = await recoverMessageAddress({ message: proofMessage(proof.payer, proof.timestamp), signature: proof.signature });
    expect(recovered).toBe(account.address);
  });
});
