import { createHash } from 'node:crypto';
import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from 'viem';
import type { OperationBinding, SessionAuthorization } from './session-types.js';

/**
 * UP-JCS-1: deterministic JSON for wire objects containing only JSON-safe
 * strings, booleans, arrays and plain objects. Object keys are sorted by code
 * point; undefined values are rejected rather than silently omitted.
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

export function operationDigest(binding: OperationBinding): Hex {
  return sha256Digest(binding);
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
