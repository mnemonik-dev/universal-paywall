import type { SecurityEventCatalog, SecurityEventName, SecurityLogger } from '../../types.js';

export interface RecordedEvent {
  name: SecurityEventName;
  payload: SecurityEventCatalog[SecurityEventName];
}

export class RecordingLogger implements SecurityLogger {
  readonly events: RecordedEvent[] = [];

  securityEvent<N extends SecurityEventName>(name: N, payload: SecurityEventCatalog[N]): void {
    this.events.push({ name, payload });
  }

  byName<N extends SecurityEventName>(name: N): Array<SecurityEventCatalog[N]> {
    return this.events
      .filter((e) => e.name === name)
      .map((e) => e.payload as SecurityEventCatalog[N]);
  }

  clear(): void {
    this.events.length = 0;
  }
}
