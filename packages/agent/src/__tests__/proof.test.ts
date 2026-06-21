import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { buildAccessProof, proofHeaders, proofMessage, type Hex } from '../proof.js';

// Public anvil dev key (account #1). Local-only, not a secret.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow

describe('proof', () => {
  it('formats the proof message canonically (lowercased payer)', () => {
    expect(proofMessage('0xAbC0000000000000000000000000000000000000' as Hex, 42)).toBe(
      'universal-paywall:0xabc0000000000000000000000000000000000000:42',
    );
  });

  it('builds a proof the gate can recover back to the payer', async () => {
    const account = privateKeyToAccount(KEY);
    const proof = await buildAccessProof(
      { address: account.address, signMessage: ({ message }) => account.signMessage({ message }) },
      1000,
    );

    expect(proof.payer).toBe(account.address);
    expect(proof.timestamp).toBe(1000);

    const recovered = await recoverMessageAddress({
      message: proofMessage(account.address, 1000),
      signature: proof.signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('produces the headers the resource adapter reads', async () => {
    const account = privateKeyToAccount(KEY);
    const proof = await buildAccessProof(
      { address: account.address, signMessage: ({ message }) => account.signMessage({ message }) },
      1000,
    );
    const headers = proofHeaders(proof);
    expect(headers['x-payer']).toBe(account.address);
    expect(headers['x-payer-timestamp']).toBe('1000');
    expect(headers['x-payer-signature']).toBe(proof.signature);
  });
});
