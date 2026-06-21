import { describe, expect, it } from 'vitest';
import { parseGrantRequirements } from '../parse402.js';

const FAC = '0xfac0000000000000000000000000000000000000';
const FACTORY = '0xf00d000000000000000000000000000000000000';

describe('parseGrantRequirements', () => {
  it('parses a full build402Body grant', () => {
    const body = {
      x402Version: 1,
      error: 'payment_required',
      accepts: [{ scheme: 'stake' }],
      grant: {
        facilitator: FAC,
        stakeVaultFactory: FACTORY,
        recommendedCap: '1000000',
        validForSeconds: 7200,
      },
    };
    expect(parseGrantRequirements(body)).toEqual({
      facilitator: FAC,
      stakeVaultFactory: FACTORY,
      recommendedCap: 1_000_000n,
      validForSeconds: 7200,
    });
  });

  it('defaults validForSeconds to 3600 when absent', () => {
    const req = parseGrantRequirements({
      grant: { facilitator: FAC, stakeVaultFactory: FACTORY, recommendedCap: '5' },
    });
    expect(req?.validForSeconds).toBe(3600);
  });

  it('returns null for a bare payer_required challenge (no recommendedCap)', () => {
    const body = { x402Version: 1, error: 'payer_required', grant: { facilitator: FAC, stakeVaultFactory: FACTORY } };
    expect(parseGrantRequirements(body)).toBeNull();
  });

  it('returns null on malformed bodies', () => {
    expect(parseGrantRequirements(null)).toBeNull();
    expect(parseGrantRequirements({})).toBeNull();
    expect(parseGrantRequirements({ grant: { facilitator: 'nope', stakeVaultFactory: FACTORY, recommendedCap: '1' } })).toBeNull();
  });
});
