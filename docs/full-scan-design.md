# Design: local metadata index (fixing the sampled-senders problem)

Status: **proposed, not built.** Written 2026-08-31.

## The problem

`GmailProvider.refresh()` re-derives everything from a live 300-message sample of
`larger:1M` on every load. Consequences:

- **"Top senders" can't answer its own question.** A sender with 10,000 × 200 KB
  emails (2 GB — exactly what this app exists to find) never appears, because none
  of its messages are in the top 300 by size. Today the UI admits this in its
  caption; that's honest, not fixed.
- **Byte figures are sampled, not summed.** Rule estimates extrapolate from a
  25-message mean.
- **Every visit re-scans.** Nothing is remembered between sessions.

## The binding constraint: quota, not storage

Gmail charges 5 quota units per `messages.get`, and the per-user ceiling is
250 units/sec. `messages.list` returns only `{id, threadId}` — no size — so
obtaining `sizeEstimate` costs one `get` per message. Batching via the HTTP batch
endpoint cuts round-trips but **not** quota.

For this account (144,190 messages):

| Scan scope | Quota units | Wall clock | IndexedDB |
|---|---|---|---|
| Entire mailbox | 720,950 | **~48 min** | ~29 MB |
| `larger:100k` @ 20k msgs | 100,000 | ~6.7 min | ~4 MB |
| `larger:100k` @ 10k msgs | 50,000 | ~3.3 min | ~2 MB |

**48 minutes exceeds the ~60-minute access-token lifetime**, so a full-mailbox
scan would routinely need mid-scan re-auth. That rules it out as the default.

## The design: scan by size tier, not everything

Storage is concentrated in large messages, and the invisible-sender case
(many medium emails) lives above 100 KB. So:

1. **Index `larger:100k` completely.** This is the storage-relevant population.
   Per-sender totals over it are *exact sums*, not samples — which fixes the
   senders panel for both the big-attachment and many-medium-emails cases.
2. **Bound the sub-100 KB tail statistically.** Get its count from
   `messages.list` (cheap: 5 units per 500 ids) and its mean from a ~200-message
   sample. Present as one aggregate line — "small mail: ~1.8 GB across 121,400
   emails" — clearly labelled an estimate, with no per-sender attribution.
   Rationale: no single sender is likely to dominate it, and it isn't
   individually actionable.

This buys exact numbers where they drive decisions and honest estimates where
they don't, at ~7 minutes instead of ~48.

## Components

### 1. Store (`src/lib/store.ts`, ~150 lines)

```
db "gigback" v1
  messages  keyPath id  { id, fromEmail, fromName, subject, date, sizeBytes, labels }
            indexes: bySender, bySize, byDate
  meta      keyPath key { accountEmail, historyId, scanState, tailEstimate }
```

`scanState = { phase, pageToken, scannedCount, startedAt, completedAt }` — the
checkpoint that makes the scan resumable.

### 2. Scanner (`src/lib/scanner.ts`, ~250 lines)

- Pages ids via `messages.list`, fetches metadata through the batch endpoint
  (100 sub-requests per HTTP call).
- **Token-bucket limiter at ~200 units/sec** (headroom under the 250 ceiling).
  This replaces reactive 429-backoff with proactive pacing — backoff alone
  wastes the whole burst allowance.
- Checkpoints `pageToken` after every page, so expiry/reload/tab-close resumes
  rather than restarting.
- Single-writer lock (Web Locks API) so two tabs can't double-scan.

### 3. Aggregator (`src/lib/aggregate.ts`, ~120 lines)

Runs in a Web Worker; 20k records is enough to jank the main thread. Produces
the existing `Overview` shape, so the UI contract doesn't change: per-sender
exact totals, largest-N messages, per-category totals from `labels`.

### 4. Delta sync (`src/lib/sync.ts`, ~100 lines)

`users.history.list?startHistoryId=…` costs 2 units and returns only what
changed. Store `historyId` after each scan; on return visits, sync the delta
instead of re-scanning. Gmail retains history ~7 days and returns 404 when the
id is too old → fall back to a full rescan.

### 5. UI (~150 lines)

- **Progressive**: keep today's fast sample scan for first paint (~5 s,
  labelled "quick scan"), run the full index in the background, upgrade the
  dashboard live, flip the label to "complete — exact totals".
- Progress indicator with a real ETA (derivable from the quota math).
- **"Clear local cache"** control — required, see privacy below.
- "Exact" vs "estimated" badges on figures, replacing today's blanket `~`.

### 6. Provider refactor (~100 lines)

`GmailProvider.refresh()` reads from the store instead of scanning live. Cleanup
actions still hit Gmail directly and then patch the local index.

## Privacy: this expands the disclosed surface

Today nothing persists; mail metadata lives only in memory. This design writes
sender, subject, size, and date **to disk** in the browser. That's still local —
no server ever sees it — but "your mail never touches our servers" no longer
covers the whole story, and the copy must say so:

> Gigback caches email metadata (sender, subject, size, date) in your browser so
> it doesn't have to re-scan. It never leaves your device. Clear it anytime.

Non-negotiables: a working "Clear local cache" button, cache keyed to the
account so a different login can't read it, and disclosure on the landing page.

## Risks

| Risk | Mitigation |
|---|---|
| Token expiry mid-scan | Resumable checkpoints + the existing reconnect prompt; ~7 min scan makes it rare |
| `historyId` older than ~7 days | Detect 404 → full rescan |
| IndexedDB unavailable (private mode, Safari quirks) | Feature-detect, fall back to today's in-memory sample |
| Two tabs scanning at once | Web Locks single-writer |
| Quota exhaustion | Token-bucket pacing, not just 429 retry |
| Stale index after external changes | Delta sync on load; "rescan" control |

## Effort

~900 lines of new and changed code — roughly a 60% increase over the current
~1,550-line codebase, and the largest single piece of work in the project so far.

## Sequencing recommendation

**Measure first (10 minutes).** One `messages.list?q=larger:100k` call returns
`resultSizeEstimate` — the population size that determines whether this is a
3-minute or 13-minute scan. Build nothing before knowing that number.

**Then consider the cheap interim (~20 lines).** Widening the existing sample
from 300 messages of `larger:1M` to ~2,000 of `larger:100k` costs ~10,000 units
(~40 s) and captures most storage-relevant senders. It doesn't make figures
exact, but it substantially reduces the invisible-sender problem for a fraction
of the work.

**Build the full index when there's usage to justify it.** The architecture here
is right, but the app currently has one real user and no observed friction. The
interim step buys most of the correctness at ~2% of the effort; the full index is
worth it once people are actually returning to the app and the sampled numbers
are demonstrably getting in their way.
