// Demo mode: a deterministic fake inbox held entirely in memory. Trashing
// mutates the local state so the storage numbers respond, which makes the
// UX testable end-to-end without Google credentials.
import type {
  MailMessage,
  MailProvider,
  Overview,
  Rule,
  RulePreview,
  SenderStat,
} from "./types";

const SENDER_POOL: [string, string, number, number][] = [
  // [email, name, message count, avg KB]
  ["newsletters@medium.com", "Medium Daily Digest", 3120, 812],
  ["no-reply@linkedin.com", "LinkedIn", 2480, 402],
  ["promos@wayfair.com", "Wayfair Deals", 1930, 655],
  ["updates@github.com", "GitHub", 1720, 118],
  ["hello@substack.com", "Substack", 1410, 388],
  ["noreply@youtube.com", "YouTube", 1265, 91],
  ["offers@dominos.com", "Domino's Pizza", 980, 240],
  ["team@figma.com", "Figma", 730, 66],
  ["billing@aws.amazon.com", "AWS Billing", 610, 154],
  ["family@photos-share.com", "Photo Share", 310, 2900],
  ["recruiting@hired.com", "Hired", 290, 48],
  ["it-alerts@example-corp.com", "IT Alerts", 4200, 380],
];

const SUBJECT_POOL = [
  "Your weekly digest is here",
  "Project files attached — final version",
  "Re: Q3 planning deck",
  "Vacation photos from the trip!!",
  "Invoice and receipt attached",
  "Backup export — do not delete",
  "50% off everything this weekend only",
  "Screen recording of the bug",
  "Signed contract (scanned)",
  "Presentation video for review",
];

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildState() {
  const rand = mulberry32(42);
  const now = Date.now();

  const senders: SenderStat[] = SENDER_POOL.map(([email, name, count, avgKb]) => ({
    email,
    name,
    count,
    totalBytes: Math.round(count * avgKb * 1024 * (0.8 + rand() * 0.4)),
  })).sort((a, b) => b.totalBytes - a.totalBytes);

  const promoSenders = new Set([
    "promos@wayfair.com",
    "offers@dominos.com",
    "newsletters@medium.com",
    "hello@substack.com",
  ]);

  const largeMessages: MailMessage[] = [];
  for (let i = 0; i < 60; i++) {
    const s = SENDER_POOL[Math.floor(rand() * SENDER_POOL.length)];
    const ageDays = Math.floor(rand() * 365 * 4);
    largeMessages.push({
      id: `mock-${i}`,
      threadId: `mock-t-${i}`,
      from: `${s[1]} <${s[0]}>`,
      fromEmail: s[0],
      subject: SUBJECT_POOL[Math.floor(rand() * SUBJECT_POOL.length)],
      date: new Date(now - ageDays * 86400000).toISOString(),
      sizeBytes: Math.round((2 + rand() * 38) * 1024 * 1024),
      labels: promoSenders.has(s[0]) ? ["CATEGORY_PROMOTIONS"] : ["INBOX"],
    });
  }
  largeMessages.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    senders,
    largeMessages,
    categories: [
      { key: "CATEGORY_PROMOTIONS", label: "Promotions", count: 18240 },
      { key: "CATEGORY_SOCIAL", label: "Social", count: 6410 },
      { key: "CATEGORY_UPDATES", label: "Updates", count: 12930 },
      { key: "CATEGORY_FORUMS", label: "Forums", count: 1180 },
      { key: "SPAM", label: "Spam", count: 96 },
    ],
    usageInGmailBytes: Math.round(9.8 * 1024 ** 3),
    trashedBytes: 0,
    messagesTotal: 48211,
  };
}

const AVG_PROMO_BYTES = 380 * 1024; // rough per-message estimate for rule previews

export class DemoProvider implements MailProvider {
  readonly demo = true;
  private state = buildState();

  private overview(): Overview {
    const s = this.state;
    const usageInGmailBytes = s.usageInGmailBytes;
    const usageInDriveBytes = Math.round(2.1 * 1024 ** 3);
    const usageInPhotosBytes = Math.round(1.2 * 1024 ** 3);
    return {
      profile: { email: "demo@gigback.app", messagesTotal: s.messagesTotal },
      quota: {
        limitBytes: 15 * 1024 ** 3,
        usageBytes: usageInGmailBytes + usageInDriveBytes + usageInPhotosBytes,
        usageInGmailBytes,
        usageInDriveBytes,
        usageInPhotosBytes,
      },
      categories: s.categories.map((c) => ({ ...c })),
      senders: s.senders.filter((x) => x.count > 0).map((x) => ({ ...x })),
      largeMessages: s.largeMessages.map((m) => ({ ...m })),
    };
  }

  private delay<T>(v: T, ms = 350): Promise<T> {
    return new Promise((res) => setTimeout(() => res(v), ms));
  }

  connect() {
    return this.delay(this.overview(), 600);
  }

  refresh() {
    return this.delay(this.overview(), 200);
  }

  trashMessages(ids: string[]) {
    const s = this.state;
    const idSet = new Set(ids);
    let freed = 0;
    s.largeMessages = s.largeMessages.filter((m) => {
      if (!idSet.has(m.id)) return true;
      freed += m.sizeBytes;
      const sender = s.senders.find((x) => x.email === m.fromEmail);
      if (sender) {
        sender.count -= 1;
        sender.totalBytes = Math.max(0, sender.totalBytes - m.sizeBytes);
      }
      return false;
    });
    s.usageInGmailBytes -= freed;
    s.trashedBytes += freed;
    s.messagesTotal -= ids.length;
    return this.delay(ids.length);
  }

  trashSender(email: string) {
    const s = this.state;
    const sender = s.senders.find((x) => x.email === email);
    if (!sender) return this.delay(0);
    const n = sender.count;
    s.usageInGmailBytes -= sender.totalBytes;
    s.trashedBytes += sender.totalBytes;
    s.messagesTotal -= n;
    s.largeMessages = s.largeMessages.filter((m) => m.fromEmail !== email);
    sender.count = 0;
    sender.totalBytes = 0;
    return this.delay(n, 700);
  }

  previewRule(rule: Rule): Promise<RulePreview> {
    const { matched, estimatedBytes, query } = this.matchRule(rule);
    return this.delay({ matched, estimatedBytes, query }, 400);
  }

  runRule(rule: Rule) {
    const s = this.state;
    const { matched, estimatedBytes } = this.matchRule(rule);
    if (rule.category) {
      const cat = s.categories.find((c) => c.key === rule.category);
      if (cat) cat.count -= matched;
    }
    const cutoff = Date.now() - rule.olderThanDays * 86400000;
    s.largeMessages = s.largeMessages.filter(
      (m) =>
        new Date(m.date).getTime() > cutoff ||
        (rule.category ? !m.labels.includes(rule.category) : false) ||
        (rule.fromEmail ? m.fromEmail !== rule.fromEmail : false)
    );
    s.usageInGmailBytes -= estimatedBytes;
    s.trashedBytes += estimatedBytes;
    s.messagesTotal -= matched;
    return this.delay(matched, 900);
  }

  private matchRule(rule: Rule) {
    const s = this.state;
    // Rough demo estimate: category count scaled by age share, or sender totals.
    let matched = 0;
    let estimatedBytes = 0;
    const ageShare = Math.min(1, rule.olderThanDays / (365 * 3));
    if (rule.fromEmail) {
      const sender = s.senders.find((x) => x.email === rule.fromEmail);
      matched = Math.round((sender?.count ?? 0) * ageShare);
      estimatedBytes = Math.round((sender?.totalBytes ?? 0) * ageShare);
    } else if (rule.category) {
      const cat = s.categories.find((c) => c.key === rule.category);
      matched = Math.round((cat?.count ?? 0) * ageShare);
      estimatedBytes = matched * AVG_PROMO_BYTES;
    }
    const parts = [`older_than:${rule.olderThanDays}d`];
    if (rule.category) parts.push(`category:${rule.category.replace("CATEGORY_", "").toLowerCase()}`);
    if (rule.fromEmail) parts.push(`from:${rule.fromEmail}`);
    parts.push("-is:starred", "-is:important", "-in:trash");
    return { matched, estimatedBytes, query: parts.join(" ") };
  }
}
