// Metadata-only triage: recommendations are computed from sender, category,
// size, and age signals only — message content is never read. This is the v1
// "AI" layer; an LLM can later rank/word these using the same metadata.
import type { Overview, Recommendation, Rule } from "./types";
import { ageYears } from "./format";
import { fmtBytes, fmtNum } from "./format";

const NEWSLETTERISH = /(newsletter|no-?reply|noreply|promo|offers|updates|digest|marketing|notif)/i;

export function buildRecommendations(o: Overview): Recommendation[] {
  const recs: Recommendation[] = [];

  // 1. Old promotions — highest-volume, lowest-risk cleanup.
  const promos = o.categories.find((c) => c.key === "CATEGORY_PROMOTIONS");
  if (promos && promos.count > 500) {
    const rule: Rule = { olderThanDays: 365, category: "CATEGORY_PROMOTIONS" };
    const est = Math.round(promos.count * 0.6) * 380 * 1024;
    recs.push({
      id: "old-promos",
      title: "Promotions older than 1 year",
      detail: `~${fmtNum(Math.round(promos.count * 0.6))} promotional emails you haven't needed since last year. Starred and important mail is always excluded.`,
      estimatedBytes: est,
      confidence: "safe",
      action: { kind: "rule", rule },
    });
  }

  // 2. Bulk senders that look like automated mail.
  for (const s of o.senders.slice(0, 8)) {
    if (s.count >= 500 && NEWSLETTERISH.test(s.email) && s.totalBytes > 200 * 1024 * 1024) {
      recs.push({
        id: `sender-${s.email}`,
        title: `Everything from ${s.name}`,
        detail: `${fmtNum(s.count)} automated emails from ${s.email} taking ${fmtBytes(s.totalBytes)}.`,
        estimatedBytes: s.totalBytes,
        confidence: "safe",
        action: { kind: "sender", email: s.email },
      });
    }
  }

  // 3. Huge, old attachments — big wins but personal mail, so flag for review.
  const oldBig = o.largeMessages.filter((m) => m.sizeBytes > 10 * 1024 * 1024 && ageYears(m.date) > 2);
  if (oldBig.length >= 3) {
    recs.push({
      id: "old-big-attachments",
      title: `${oldBig.length} huge attachments older than 2 years`,
      detail: "Each over 10 MB. Review the list below before trashing — these may include personal files.",
      estimatedBytes: oldBig.reduce((a, m) => a + m.sizeBytes, 0),
      confidence: "review",
      action: { kind: "messages", ids: oldBig.map((m) => m.id) },
    });
  }

  return recs.sort((a, b) => b.estimatedBytes - a.estimatedBytes).slice(0, 4);
}
