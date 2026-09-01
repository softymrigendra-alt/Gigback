// Real Gmail provider — the browser talks straight to Google's REST APIs.
// Mail data never touches a Gigback server. Requires a Google OAuth client
// id (VITE_GOOGLE_CLIENT_ID) configured for "Web application" with this
// origin in the allowed JavaScript origins.
import type {
  CategoryStat,
  MailMessage,
  MailProvider,
  Overview,
  Rule,
  RulePreview,
  SenderStat,
  TrashResult,
} from "./types";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_ABOUT = "https://www.googleapis.com/drive/v3/about?fields=storageQuota";

const MAX_RETRIES = 4;
/** Max messages one rule run will trash. previewRule reports this same cap. */
const RULE_CAP = 2000;
/** Messages sampled to derive a real mean size for rule estimates. */
const SIZE_SAMPLE = 25;

// Redirect-based OAuth (implicit grant), not a popup: browsers, extensions,
// and mobile Safari routinely block or silently kill popups, which left the
// old popup-based flow stuck on "closed before completing" for real users.
// A full-page redirect can't be blocked, at the cost of a page reload.
function buildAuthUrl(): string {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("VITE_GOOGLE_CLIENT_ID is not set — see README.md");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: window.location.origin,
    response_type: "token",
    scope: SCOPES,
    include_granted_scopes: "true",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Call from a click handler to start sign-in. Navigates away immediately. */
export function startGoogleSignIn(): void {
  window.location.assign(buildAuthUrl());
}

export interface GoogleSession {
  token: string;
  /** Epoch ms when Google's access token stops working (~1h from grant). */
  expiresAt: number;
}

/**
 * Thrown when the access token is gone or rejected. Distinct from other API
 * failures so the UI can offer "Reconnect" instead of a dead-end error —
 * the token is memory-only and implicit-grant has no refresh token, so
 * re-consent is the only recovery.
 */
export class AuthExpiredError extends Error {
  constructor(message = "Your Google session expired.") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

/**
 * Call once on app load to check whether we just landed back from Google's
 * redirect. Strips the token out of the URL fragment immediately so it
 * doesn't linger in the address bar or browser history.
 */
export function consumeRedirectToken(): GoogleSession | null {
  if (!window.location.hash) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("access_token");
  const error = params.get("error");
  if (!token && !error) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  if (error) throw new Error(`Google sign-in failed: ${error}`);
  // Trust Google's expires_in, minus a small safety margin so we surface
  // "reconnect" before a request fails rather than after.
  const expiresIn = Number(params.get("expires_in")) || 3600;
  return { token: token!, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
}

const CATEGORY_LABELS: Record<string, string> = {
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
  SPAM: "Spam",
};

export class GmailProvider implements MailProvider {
  readonly demo = false;
  private session: GoogleSession | null;

  /** session comes from consumeRedirectToken() after Google redirects back. */
  constructor(session: GoogleSession) {
    this.session = session;
  }

  /** ms until the token lapses; <= 0 means it already has. */
  msUntilExpiry(): number {
    return this.session ? this.session.expiresAt - Date.now() : 0;
  }

  /**
   * Gmail allows 250 quota units/sec/user and messages.get costs 5, so a wide
   * metadata scan reliably trips 429s on a large mailbox. Retry those (and
   * transient 5xx) with exponential backoff + jitter rather than failing the
   * whole scan.
   */
  private async api<T>(url: string, init?: RequestInit, attempt = 0): Promise<T> {
    // Check expiry locally first — cheaper than a round trip, and it means a
    // long scan fails fast at the start instead of halfway through.
    if (!this.session || this.msUntilExpiry() <= 0) {
      this.session = null;
      throw new AuthExpiredError();
    }
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.session.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401) {
      this.session = null;
      throw new AuthExpiredError();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const backoff = 2 ** attempt * 500 + Math.random() * 250;
      await new Promise((r) => setTimeout(r, backoff));
      return this.api<T>(url, init, attempt + 1);
    }
    if (!res.ok) throw new Error(`Google API error ${res.status}: ${await res.text()}`);
    return res.status === 204 ? (undefined as T) : res.json();
  }

  private async listIds(q: string, cap = 500): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = "";
    while (ids.length < cap) {
      const params = new URLSearchParams({ q, maxResults: String(Math.min(500, cap - ids.length)) });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.api<any>(`${GMAIL}/messages?${params}`);
      ids.push(...(data.messages ?? []).map((m: any) => m.id));
      pageToken = data.nextPageToken;
      if (!pageToken || !data.messages?.length) break;
    }
    return ids;
  }

  private async getMetadata(ids: string[], concurrency = 30): Promise<MailMessage[]> {
    const out: MailMessage[] = [];
    for (let i = 0; i < ids.length; i += concurrency) {
      const chunk = await Promise.all(
        ids.slice(i, i + concurrency).map(async (id) => {
          const m = await this.api<any>(
            `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`
          );
          const header = (name: string) =>
            m.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
          const from = header("From");
          const match = from.match(/^(.*?)\s*<(.+)>$/);
          return {
            id: m.id,
            threadId: m.threadId,
            from,
            fromEmail: (match ? match[2] : from).toLowerCase(),
            subject: header("Subject") || "(no subject)",
            date: new Date(Number(m.internalDate)).toISOString(),
            sizeBytes: m.sizeEstimate ?? 0,
            labels: m.labelIds ?? [],
          } as MailMessage;
        })
      );
      out.push(...chunk);
    }
    return out;
  }

  async connect(): Promise<Overview> {
    return this.refresh();
  }

  async refresh(): Promise<Overview> {
    const [profile, about] = await Promise.all([
      this.api<any>(`${GMAIL}/profile`),
      this.api<any>(DRIVE_ABOUT),
    ]);

    const categories: CategoryStat[] = await Promise.all(
      Object.entries(CATEGORY_LABELS).map(async ([key, label]) => {
        const d = await this.api<any>(`${GMAIL}/labels/${key}`).catch(() => null);
        return { key, label, count: d?.messagesTotal ?? 0 };
      })
    );

    // One fetch pass covers both the largest-emails table and the top-senders
    // aggregation — previously these were two separate scans (200 + 600
    // individual message.get() calls, ~800 total), which made the first
    // connect take 15-20+ seconds. Reusing a single "larger:1M" sample for
    // both cuts that to ~300 calls and keeps both views consistent with
    // each other.
    const ids = await this.listIds("larger:1M -in:trash", 300);
    const messages = await this.getMetadata(ids);
    const largeMessages = [...messages].sort((a, b) => b.sizeBytes - a.sizeBytes);

    const bySender = new Map<string, SenderStat>();
    for (const m of messages) {
      const match = m.from.match(/^(.*?)\s*<(.+)>$/);
      const name = match ? match[1].replace(/^"|"$/g, "") : m.fromEmail;
      const cur = bySender.get(m.fromEmail) ?? { email: m.fromEmail, name, count: 0, totalBytes: 0 };
      cur.count += 1;
      cur.totalBytes += m.sizeBytes;
      bySender.set(m.fromEmail, cur);
    }
    const senders = [...bySender.values()].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 25);

    const q = about.storageQuota ?? {};
    const usage = Number(q.usage ?? 0);
    const usageInDrive = Number(q.usageInDrive ?? 0);
    return {
      profile: { email: profile.emailAddress, messagesTotal: profile.messagesTotal },
      quota: {
        limitBytes: Number(q.limit ?? 0),
        usageBytes: usage,
        usageInDriveBytes: usageInDrive,
        // Drive's quota API doesn't split Gmail vs Photos; show the remainder as Gmail.
        usageInGmailBytes: Math.max(0, usage - usageInDrive),
        usageInPhotosBytes: 0,
      },
      categories: categories.filter((c) => c.count > 0),
      senders,
      largeMessages,
    };
  }

  async trashMessages(ids: string[]): Promise<TrashResult> {
    for (let i = 0; i < ids.length; i += 1000) {
      // Only ADD the TRASH label — never strip INBOX. Adding TRASH already
      // removes the message from the inbox view, and leaving the rest of the
      // label set untouched is what makes restoreMessages a lossless inverse.
      // (Stripping INBOX here meant archived mail came back into the inbox.)
      await this.api(`${GMAIL}/messages/batchModify`, {
        method: "POST",
        body: JSON.stringify({ ids: ids.slice(i, i + 1000), addLabelIds: ["TRASH"] }),
      });
    }
    return { count: ids.length, ids };
  }

  async trashSender(email: string): Promise<TrashResult> {
    const ids = await this.listIds(`from:${email} -is:starred -is:important -in:trash`, 2000);
    if (ids.length) await this.trashMessages(ids);
    return { count: ids.length, ids };
  }

  /**
   * Exact inverse of trashMessages: drops the TRASH label and nothing else,
   * so each message returns to wherever its own labels already put it —
   * inbox mail to the inbox, archived mail back to archived.
   */
  async restoreMessages(ids: string[]): Promise<number> {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.api(`${GMAIL}/messages/batchModify`, {
        method: "POST",
        body: JSON.stringify({ ids: ids.slice(i, i + 1000), removeLabelIds: ["TRASH"] }),
      });
    }
    return ids.length;
  }

  private ruleQuery(rule: Rule): string {
    const parts = [`older_than:${Math.round(rule.olderThanDays)}d`];
    if (rule.category) parts.push(`category:${rule.category.replace("CATEGORY_", "").toLowerCase()}`);
    if (rule.fromEmail) parts.push(`from:${rule.fromEmail}`);
    parts.push("-is:starred", "-is:important", "-in:trash");
    return parts.join(" ");
  }

  async previewRule(rule: Rule): Promise<RulePreview> {
    const query = this.ruleQuery(rule);
    // Gmail's resultSizeEstimate is approximate, so page real ids up to the
    // same cap runRule will use — that way the number shown is the number
    // actually acted on, and `capped` tells the UI when more remain.
    const ids = await this.listIds(query, RULE_CAP);
    const capped = ids.length >= RULE_CAP;

    // Derive mean size from a real sample instead of a hardcoded guess.
    let estimatedBytes = 0;
    if (ids.length) {
      const sample = await this.getMetadata(ids.slice(0, SIZE_SAMPLE));
      const meanBytes = sample.length
        ? sample.reduce((a, m) => a + m.sizeBytes, 0) / sample.length
        : 0;
      estimatedBytes = Math.round(meanBytes * ids.length);
    }
    return { matched: ids.length, estimatedBytes, query, capped };
  }

  async runRule(rule: Rule): Promise<TrashResult> {
    const ids = await this.listIds(this.ruleQuery(rule), RULE_CAP);
    if (ids.length) await this.trashMessages(ids);
    return { count: ids.length, ids };
  }
}
