import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import { operationDigest, sessionScopeHash } from '../canonical.js';
import { sessionTypedData, type SessionVerifierConfig } from '../session-auth.js';
import type { OperationBinding, SessionAuthorization } from '../session-types.js';

interface Fixture {
  authorization: SessionAuthorization;
  scope_hash: string;
  typed_data_digest: string;
  operation_binding: OperationBinding;
  operation_digest: string;
}

const fixture = JSON.parse(
  readFileSync(new URL('../../fixtures/session-operation.v1.json', import.meta.url), 'utf8'),
) as Fixture;

describe('session-operation.v1 interoperability fixture', () => {
  it('pins canonical operation, scope, and EIP-712 digests', () => {
    const config: SessionVerifierConfig = {
      serviceId: fixture.authorization.service_id,
      network: fixture.authorization.network,
      chainId: 5_042_002,
      asset: fixture.authorization.asset,
      facilitator: fixture.authorization.facilitator,
      payTo: fixture.authorization.pay_to,
    };
    expect(operationDigest(fixture.operation_binding)).toBe(fixture.operation_digest);
    expect(sessionScopeHash(fixture.authorization)).toBe(fixture.scope_hash);
    expect(hashTypedData(sessionTypedData(fixture.authorization, config))).toBe(
      fixture.typed_data_digest,
    );
  });
});
