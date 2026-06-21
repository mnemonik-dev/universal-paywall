import { afterEach, beforeEach, vi } from 'vitest';

export function useFakeTimers(systemTimeMs = 1_700_000_000_000): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(systemTimeMs));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
