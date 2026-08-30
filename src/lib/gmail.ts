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
} from "./types";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_ABOUT = "https://www.googleapis.com/drive/v3/about?fields=storageQuota";

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

/**
 * Call once on app load to check whether we just landed back from Google's
 * redirect. Strips the token out of the URL fragment immediately so it
 * doesn't linger in the address bar or browser history.
 */
export function consumeRedirectToken(): string | null {
  if (!window.location.hash) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("access_token");
  const error = params.get("error");
  if (!token && !error) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  if (error) throw new Error(`Google sign-in failed: ${error}`);
  return token;
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
  private token: string | null;

  /** token comes from consumeRedirectToken() after Google redirects back. */
  constructor(token: string) {
    this.token = token;
  }

  private async api<T>(url: string, init?: RequestInit): Promise<T> {
    if (!this.token) throw new Error('Not signed in — click "Connect Gmail" to continue.');
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401) {
      this.token = null; // token expired — re-run authorize on next call
      throw new Error("Session expired, please retry");
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

  async trashMessages(ids: string[]): Promise<number> {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.api(`${GMAIL}/messages/batchModify`, {
        method: "POST",
        body: JSON.stringify({
          ids: ids.slice(i, i + 1000),
          addLabelIds: ["TRASH"],
          removeLabelIds: ["INBOX"],
        }),
      });
    }
    return ids.length;
  }

  async trashSender(email: string): Promise<number> {
    const ids = await this.listIds(`from:${email} -is:starred -is:important -in:trash`, 2000);
    if (ids.length) await this.trashMessages(ids);
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
    const params = new URLSearchParams({ q: query, maxResults: "1" });
    const data = await this.api<any>(`${GMAIL}/messages?${params}`);
    const matched = data.resultSizeEstimate ?? 0;
    return { matched, estimatedBytes: matched * 300 * 1024, query };
  }

  async runRule(rule: Rule): Promise<number> {
    const ids = await this.listIds(this.ruleQuery(rule), 2000);
    if (ids.length) await this.trashMessages(ids);
    return ids.length;
  }
}
