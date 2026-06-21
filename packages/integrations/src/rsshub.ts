import type { Reporter, ReportOutcome } from './core.js';

/**
 * Feeds — RSSHub citation-toll. When an LLM crawler grounds a generated answer
 * in a source item, it pays a per-citation toll to the source author. Attach at
 * the crawler boundary (or as RSSHub middleware); `DataItem.link` / `author` are
 * the settlement-grade fields.
 */

export interface CitationEvent {
  /** The grounding crawler/agent (resolves to its payer wallet). */
  crawlerId: string;
  /** Canonical source URL (`DataItem.link`) — fallback payee key. */
  link: string;
  /** Author name or URL (`DataItem.author`) — preferred payee key. */
  author?: string;
}

export interface CitationOptions {
  /** Per-citation toll in micro-USDC. */
  toll: bigint;
}

/** Reports one grounding citation as a toll from the crawler to the source. */
export function handleCitation(ev: CitationEvent, reporter: Reporter, opts: CitationOptions): Promise<ReportOutcome> {
  // Prefer the author identity; fall back to the canonical link.
  const creatorKey = ev.author !== undefined && ev.author.length > 0 ? ev.author : ev.link;
  return reporter.report({
    payerKey: ev.crawlerId,
    creatorKey,
    amount: opts.toll,
    ref: `citation:${ev.crawlerId}:${ev.link}`,
  });
}
