import { createHash } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from 'viem';
import type { OperationBinding, SessionAuthorization } from './session-types.js';

/**
 * UP-JCS-1: deterministic JSON for internal objects (receipt payloads, session
 * digests, concurrency fingerprints). Object keys are sorted by code point;
 * undefined values are rejected rather than silently omitted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const child = record[key];
        if (child === undefined) throw new Error(`undefined_value:${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(child)}`;
      })
      .join(',')}}`;
  }
  throw new Error(`unsupported_canonical_type:${typeof value}`);
}

export function sha256Digest(value: unknown): Hex {
  return `0x${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/**
 * UP-OPBIND-1: operation binding serialization used for the V1 wire digest.
 * Fields are serialized in the order defined by the Mnemonic/Universal Paywall
 * integration spec so independent implementations produce identical BLAKE3
 * digests. `workspace_hash` is omitted when undefined.
 */
export function operationBindingJson(binding: OperationBinding): string {
  const scope: Record<string, unknown> = {
    workspace_hash: binding.scope.workspace_hash,
    visibility: binding.scope.visibility,
    action: binding.scope.action,
  };
  if (scope.workspace_hash === undefined) {
    delete scope.workspace_hash;
  }
  return JSON.stringify({
    version: binding.version,
    operation_id: binding.operation_id,
    payer_subject: binding.payer_subject,
    payer_wallet: binding.payer_wallet,
    artifact_hash: binding.artifact_hash,
    amount: binding.amount,
    asset: binding.asset,
    network: binding.network,
    pay_to: binding.pay_to,
    expires_at: binding.expires_at,
    nonce: binding.nonce,
    scope,
  });
}

export function operationDigest(binding: OperationBinding): Hex {
  return `0x${bytesToHex(blake3(Buffer.from(operationBindingJson(binding), 'utf8')))}`;
}

export function sessionScopeHash(auth: SessionAuthorization): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('string,string,string,string,bytes32,string,bytes32'), [
      auth.service_id,
      auth.session_id,
      auth.payer_subject,
      auth.network,
      auth.workspace_hash,
      auth.visibility,
      keccak256(Buffer.from(canonicalJson(auth.allowed_actions), 'utf8')),
    ]),
  );
}
