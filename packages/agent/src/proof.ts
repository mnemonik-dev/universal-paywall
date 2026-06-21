export type Hex = `0x${string}`;

export const PROOF_PREFIX = 'universal-paywall';

/** Message a payer signs to prove control for a request (must match the gate). */
export function proofMessage(payer: Hex, timestamp: number): string {
  return `${PROOF_PREFIX}:${payer.toLowerCase()}:${timestamp}`;
}

export interface AccessProof {
  payer: Hex;
  timestamp: number;
  signature: Hex;
}

/** Minimal signer shape (a viem LocalAccount satisfies this). */
export interface ProofSigner {
  address: Hex;
  signMessage: (args: { message: string }) => Promise<Hex>;
}

/** Builds a fresh, timestamped access proof signed by the payer. */
export async function buildAccessProof(
  signer: ProofSigner,
  now: number = Math.floor(Date.now() / 1000),
): Promise<AccessProof> {
  const message = proofMessage(signer.address, now);
  const signature = await signer.signMessage({ message });
  return { payer: signer.address, timestamp: now, signature };
}

/** Turns a proof into the request headers the resource adapter expects. */
export function proofHeaders(proof: AccessProof): Record<string, string> {
  return {
    'x-payer': proof.payer,
    'x-payer-timestamp': String(proof.timestamp),
    'x-payer-signature': proof.signature,
  };
}
