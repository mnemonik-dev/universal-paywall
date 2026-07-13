import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  OperationBinding,
  PaymentAuthorization,
  PaymentReceipt,
  PaymentState,
  RegisterSessionRequest,
} from './session-types.js';

export interface StoredSession {
  request: RegisterSessionRequest;
  digest: string;
  created_at: string;
}

export interface StoredPayment {
  binding: OperationBinding;
  binding_digest: string;
  scheme: 'stake' | 'exact';
  payment: PaymentAuthorization;
  state: PaymentState;
  session_id?: string;
  receipt?: PaymentReceipt;
  error?: string;
  updated_at: string;
}

export interface StoredQuote {
  quote_id: string;
  binding: OperationBinding;
  binding_digest: string;
  created_at: string;
}

export interface PaymentStore {
  getSession(sessionId: string): StoredSession | undefined;
  putSession(sessionId: string, session: StoredSession): void;
  getQuote(operationId: string): StoredQuote | undefined;
  putQuote(operationId: string, quote: StoredQuote): void;
  getPayment(operationId: string): StoredPayment | undefined;
  putPayment(operationId: string, payment: StoredPayment): void;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, StoredSession>;
  quotes: Record<string, StoredQuote>;
  payments: Record<string, StoredPayment>;
}

function emptyStore(): StoreFile {
  return { version: 1, sessions: {}, quotes: {}, payments: {} };
}

/**
 * Restart-safe single-process store. Each mutation is an fsynced atomic rename.
 * The service serializes operations and sessions before calling these methods.
 * Deployments needing multiple writers should implement the same interface on a
 * transactional database with unique `(service_id, operation_id)` keys.
 */
export class FilePaymentStore implements PaymentStore {
  readonly #path: string;
  #data: StoreFile;

  constructor(path: string) {
    this.#path = resolve(path);
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#data = existsSync(this.#path)
      ? (JSON.parse(readFileSync(this.#path, 'utf8')) as StoreFile)
      : emptyStore();
    if (this.#data.version !== 1) throw new Error('unsupported_payment_store_version');
    this.#data.quotes ??= {};
  }

  getSession(sessionId: string): StoredSession | undefined {
    return this.#data.sessions[sessionId];
  }

  putSession(sessionId: string, session: StoredSession): void {
    this.#data.sessions[sessionId] = session;
    this.#persist();
  }

  getQuote(operationId: string): StoredQuote | undefined {
    return this.#data.quotes[operationId];
  }

  putQuote(operationId: string, quote: StoredQuote): void {
    this.#data.quotes[operationId] = quote;
    this.#persist();
  }

  getPayment(operationId: string): StoredPayment | undefined {
    return this.#data.payments[operationId];
  }

  putPayment(operationId: string, payment: StoredPayment): void {
    this.#data.payments[operationId] = payment;
    this.#persist();
  }

  #persist(): void {
    const temp = `${this.#path}.${process.pid}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.#data), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.#path);
    try {
      chmodSync(this.#path, 0o600);
    } catch {
      // Best-effort: permissions may already be restrictive or filesystem may not support chmod.
    }
    const directory = openSync(dirname(this.#path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
