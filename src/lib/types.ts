export interface Quota {
  limitBytes: number;
  usageBytes: number;
  usageInGmailBytes: number;
  usageInDriveBytes: number;
  usageInPhotosBytes: number;
}

export interface Profile {
  email: string;
  messagesTotal: number;
}

export interface SenderStat {
  email: string;
  name: string;
  count: number;
  totalBytes: number;
}

export interface CategoryStat {
  key: string; // Gmail label id, e.g. CATEGORY_PROMOTIONS
  label: string;
  count: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  fromEmail: string;
  subject: string;
  date: string; // ISO
  sizeBytes: number;
  labels: string[];
}

export interface Overview {
  profile: Profile;
  quota: Quota;
  categories: CategoryStat[];
  senders: SenderStat[];
  largeMessages: MailMessage[];
}

export interface Rule {
  olderThanDays: number;
  category?: string;
  fromEmail?: string;
}

export interface RulePreview {
  matched: number;
  estimatedBytes: number;
  query: string;
}

/**
 * The mail data source. DemoProvider is fully in-memory; GmailProvider talks
 * to the Gmail REST API directly from the browser. Nothing here ever routes
 * mail data through a Gigback server — there isn't one.
 */
export interface MailProvider {
  readonly demo: boolean;
  connect(): Promise<Overview>;
  /** Move messages to Gmail Trash (never permanent delete). Returns count trashed. */
  trashMessages(ids: string[]): Promise<number>;
  /** Trash everything from a sender (excluding starred/important). */
  trashSender(email: string): Promise<number>;
  previewRule(rule: Rule): Promise<RulePreview>;
  runRule(rule: Rule): Promise<number>;
  refresh(): Promise<Overview>;
}

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  estimatedBytes: number;
  confidence: "safe" | "review";
  action: { kind: "sender"; email: string } | { kind: "rule"; rule: Rule } | { kind: "messages"; ids: string[] };
}
