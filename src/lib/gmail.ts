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

declare global {
  interface Window {
    google?: any;
  }
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
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
  private token: string | null = null;

  private async authorize(): Promise<string> {
    if (this.token) return this.token;
    await loadGis();
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error("VITE_GOOGLE_CLIENT_ID is not set — see README.md");
    return new Promise((resolve, reject) => {
      // If the Google popup is blocked or the user closes it without acting,
      // Google Identity Services may never invoke a callback — guard with a timeout
      // so the UI can surface an error instead of hanging on "Loading…" forever.
      const timeout = setTimeout(
        () => reject(new Error("Sign-in timed out — check that popups are allowed for this site and try again")),
        30000
      );
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: (resp: any) => {
          clearTimeout(timeout);
          if (resp.error) return reject(new Error(resp.error));
          this.token = resp.access_token;
          resolve(resp.access_token);
        },
        error_callback: (err: any) => {
          clearTimeout(timeout);
          reject(new Error(err?.type === "popup_closed" ? "Sign-in window closed before completing" : err?.message ?? "Sign-in failed"));
        },
      });
      client.requestAccessToken();
    });
  }

  private async api<T>(url: string, init?: RequestInit): Promise<T> {
    const token = await this.authorize();
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
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

  private async getMetadata(ids: string[], concurrency = 15): Promise<MailMessage[]> {
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
    await this.authorize();
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

    // Large messages: everything over 5MB, capped for the prototype.
    const largeIds = await this.listIds("larger:5M -in:trash", 200);
    const largeMessages = (await this.getMetadata(largeIds)).sort((a, b) => b.sizeBytes - a.sizeBytes);

    // Top senders: sample recent messages >100KB and aggregate (approximation).
    const sampleIds = await this.listIds("larger:100K -in:trash", 600);
    const sample = await this.getMetadata(sampleIds);
    const bySender = new Map<string, SenderStat>();
    for (const m of sample) {
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
