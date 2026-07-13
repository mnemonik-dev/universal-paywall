import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import type { SignedProviderReceipt, SignedReceiptPayload } from './session-types.js';

export interface ReceiptSignerOptions {
  privateKeyPem: string;
  keyId: string;
}

export class ReceiptSigner {
  readonly #privateKey: KeyObject;
  readonly #keyId: string;

  constructor(opts: ReceiptSignerOptions) {
    this.#privateKey = createPrivateKey(opts.privateKeyPem);
    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('receipt_key_must_be_ed25519');
    }
    this.#keyId = opts.keyId;
  }

  sign(payload: SignedReceiptPayload): SignedProviderReceipt {
    const bytes = Buffer.from(canonicalJson(payload), 'utf8');
    return {
      payload,
      signature: {
        algorithm: 'Ed25519',
        key_id: this.#keyId,
        value: sign(null, bytes, this.#privateKey).toString('base64url'),
      },
    };
  }

  publicKeyPem(): string {
    return createPublicKey(this.#privateKey).export({ type: 'spki', format: 'pem' }).toString();
  }

  publicKeyBase64Url(): string {
    const key = createPublicKey(this.#privateKey).export({ format: 'jwk' });
    if (key.x === undefined) throw new Error('receipt_public_key_missing');
    return key.x;
  }

  keyId(): string {
    return this.#keyId;
  }
}
