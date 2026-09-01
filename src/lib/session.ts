// Persists the undo history across a page reload or a re-auth redirect.
//
// Why this exists: the access token is memory-only and implicit grant has no
// refresh token, so a lapsed session forces a full redirect. Without this,
// re-authenticating after trashing thousands of emails silently destroyed the
// only handle we had on them — the undo list was React state and died with the
// page. Restoring in Gmail is stateless per message id, so the ids alone are
// enough to make undo survive.
//
// Stored in sessionStorage (same-origin, per-tab, cleared when the tab closes),
// and holds only Gmail message ids plus byte totals — no subjects, senders, or
// message content. Keyed by account so switching accounts can't cross-restore.

const KEY = "gigback:undo-v1";

export interface PersistedEntry {
  id: string;
  label: string;
  ids: string[];
  estimatedBytes: number;
  count: number;
}

interface Payload {
  email: string;
  freedBytes: number;
  history: PersistedEntry[];
}

export function saveUndoState(email: string, freedBytes: number, history: PersistedEntry[]): void {
  try {
    if (!history.length && !freedBytes) {
      sessionStorage.removeItem(KEY);
      return;
    }
    const payload: Payload = { email, freedBytes, history };
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Private browsing or a full quota — undo just won't survive reload.
  }
}

export function loadUndoState(email: string): { freedBytes: number; history: PersistedEntry[] } | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as Payload;
    if (payload.email !== email) return null; // different account — ignore
    if (!Array.isArray(payload.history)) return null;
    return { freedBytes: payload.freedBytes ?? 0, history: payload.history };
  } catch {
    return null;
  }
}

export function clearUndoState(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
