import { useEffect, useMemo, useState } from "react";
import type { MailProvider, Overview, Recommendation, Rule, TrashResult } from "./lib/types";
import { DemoProvider } from "./lib/demo";
import { GmailProvider, consumeRedirectToken, startGoogleSignIn } from "./lib/gmail";
import { buildRecommendations } from "./lib/triage";
import { fmtBytes, fmtDate, fmtNum } from "./lib/format";

type Confirm = {
  title: string;
  body: string;
  run: () => Promise<TrashResult>;
};

type Toast = { message: string; onUndo?: () => void };

type HistoryEntry = {
  id: string;
  label: string;
  ids: string[];
  estimatedBytes: number;
  count: number;
};

export default function App() {
  const [provider, setProvider] = useState<MailProvider | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freedBytes, setFreedBytes] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  // id of the history entry currently being restored, or null if none
  const [restoring, setRestoring] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const recs = useMemo(() => (overview ? buildRecommendations(overview) : []), [overview]);

  async function start(p: MailProvider) {
    setLoading(true);
    setError(null);
    try {
      const o = await p.connect();
      setProvider(p);
      setOverview(o);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  function showToast(message: string, onUndo?: () => void) {
    setToast({ message, onUndo });
    setTimeout(() => setToast((t) => (t?.message === message ? null : t)), 8000);
  }

  async function undoEntry(entry: HistoryEntry) {
    if (!provider) return;
    setRestoring(entry.id);
    try {
      const n = await provider.restoreMessages(entry.ids);
      const o = await provider.refresh();
      setOverview(o);
      setFreedBytes((f) => Math.max(0, f - entry.estimatedBytes));
      setHistory((h) => h.filter((x) => x.id !== entry.id));
      showToast(`Restored ${fmtNum(n)} emails from Trash`);
    } catch (e: any) {
      showToast(`Undo failed: ${e.message ?? e}`);
    } finally {
      setRestoring(null);
    }
  }

  // If we just landed back from Google's redirect-based sign-in, pick the
  // token out of the URL and finish connecting automatically.
  useEffect(() => {
    try {
      const token = consumeRedirectToken();
      if (token) start(new GmailProvider(token));
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function execute(c: Confirm, estimatedBytes: number) {
    setBusy(true);
    try {
      const { count, ids } = await c.run();
      const o = await provider!.refresh();
      setOverview(o);
      setSelected(new Set());
      setFreedBytes((f) => f + estimatedBytes);
      let entry: HistoryEntry | null = null;
      if (ids.length) {
        entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          label: c.title.replace(/\?$/, ""),
          ids,
          estimatedBytes,
          count,
        };
        setHistory((h) => [entry!, ...h].slice(0, 8));
      }
      showToast(
        `Moved ${fmtNum(count)} emails to Trash — ~${fmtBytes(estimatedBytes)} queued to free`,
        entry ? () => undoEntry(entry!) : undefined
      );
    } catch (e: any) {
      showToast(`Failed: ${e.message ?? e}`);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  if (!provider || !overview) {
    return (
      <Landing
        loading={loading}
        error={error}
        onDemo={() => start(new DemoProvider())}
        onConnect={startGoogleSignIn}
      />
    );
  }

  const { quota, profile, senders, largeMessages, categories } = overview;
  const selectedBytes = largeMessages.filter((m) => selected.has(m.id)).reduce((a, m) => a + m.sizeBytes, 0);

  const askTrashSelected = () =>
    setConfirm({
      title: `Trash ${selected.size} selected emails?`,
      body: `Frees ~${fmtBytes(selectedBytes)}. They move to Gmail's Trash — recoverable for 30 days, nothing is permanently deleted.`,
      run: () => provider.trashMessages([...selected]),
    });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◧</span> Gigback
          {provider.demo && <span className="chip chip-demo">DEMO DATA</span>}
        </div>
        <div className="topbar-right">
          {freedBytes > 0 && <span className="chip chip-freed">≈ {fmtBytes(freedBytes)} reclaimed this session</span>}
          <span className="account">{profile.email}</span>
        </div>
      </header>

      <main>
        <StorageBar quota={quota} messagesTotal={profile.messagesTotal} />

        {history.length > 0 && (
          <section>
            <h2>Recent actions</h2>
            <p className="section-sub">Undo any of your last {history.length} cleanups — restores mail straight out of Trash.</p>
            <div className="history-list">
              {history.map((h) => (
                <div className="history-row" key={h.id}>
                  <div>
                    <div className="history-label">{h.label}</div>
                    <div className="cell-dim">
                      {fmtNum(h.count)} emails · ~{fmtBytes(h.estimatedBytes)}
                    </div>
                  </div>
                  <button className="btn btn-small" disabled={restoring !== null} onClick={() => undoEntry(h)}>
                    {restoring === h.id ? "Restoring…" : "Undo"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {recs.length > 0 && (
          <section>
            <h2>Recommended cleanups</h2>
            <p className="section-sub">
              Computed from metadata only — sender, size, age, category. Message content is never read.
            </p>
            <div className="rec-grid">
              {recs.map((r) => (
                <RecCard
                  key={r.id}
                  rec={r}
                  disabled={busy}
                  onRun={() =>
                    setConfirm({
                      title: r.title,
                      body: `${r.detail} Everything goes to Trash (recoverable for 30 days).`,
                      run: () =>
                        r.action.kind === "sender"
                          ? provider.trashSender(r.action.email)
                          : r.action.kind === "rule"
                            ? provider.runRule(r.action.rule)
                            : provider.trashMessages(r.action.ids),
                    })
                  }
                />
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="section-head">
            <div>
              <h2>Largest emails</h2>
              <p className="section-sub">Everything over 5 MB, biggest first.</p>
            </div>
            <button className="btn btn-danger" disabled={selected.size === 0 || busy} onClick={askTrashSelected}>
              Trash {selected.size > 0 ? `${selected.size} selected (${fmtBytes(selectedBytes)})` : "selected"}
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === largeMessages.length && largeMessages.length > 0}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(largeMessages.map((m) => m.id)) : new Set())
                    }
                  />
                </th>
                <th>From</th>
                <th>Subject</th>
                <th>Date</th>
                <th className="col-num">Size</th>
              </tr>
            </thead>
            <tbody>
              {largeMessages.slice(0, 15).map((m) => (
                <tr key={m.id} className={selected.has(m.id) ? "row-selected" : ""}>
                  <td className="col-check">
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        e.target.checked ? next.add(m.id) : next.delete(m.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td className="cell-from">{m.from.replace(/<.*>/, "").trim() || m.fromEmail}</td>
                  <td className="cell-subject">{m.subject}</td>
                  <td className="cell-dim">{fmtDate(m.date)}</td>
                  <td className="col-num cell-size">{fmtBytes(m.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {largeMessages.length > 15 && (
            <p className="table-note">Showing 15 of {largeMessages.length} large emails.</p>
          )}
        </section>

        <div className="two-col">
          <section>
            <h2>Top senders by storage</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Sender</th>
                  <th className="col-num">Emails</th>
                  <th className="col-num">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {senders.slice(0, 8).map((s) => (
                  <tr key={s.email}>
                    <td>
                      <div className="cell-from">{s.name}</div>
                      <div className="cell-dim cell-email">{s.email}</div>
                    </td>
                    <td className="col-num">{fmtNum(s.count)}</td>
                    <td className="col-num cell-size">{fmtBytes(s.totalBytes)}</td>
                    <td className="col-action">
                      <button
                        className="btn btn-small"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            title: `Trash all mail from ${s.name}?`,
                            body: `${fmtNum(s.count)} emails, ~${fmtBytes(s.totalBytes)}. Starred and important mail is kept. Recoverable from Trash for 30 days.`,
                            run: () => provider.trashSender(s.email),
                          })
                        }
                      >
                        Trash all
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <RuleBuilder
            provider={provider}
            categories={categories}
            busy={busy}
            onExecute={(c) => {
              // Route through the same confirm modal every other trash action
              // uses, instead of running immediately — the Preview step alone
              // isn't the same as an explicit "yes, trash these" confirmation.
              setConfirm(c);
              return Promise.resolve();
            }}
          />
        </div>

        <div className="trash-note">
          <strong>How freeing space works:</strong> Gigback only ever <em>moves mail to Trash</em> — nothing is
          permanently deleted. Gmail clears Trash automatically after 30 days, or you can{" "}
          <a href="https://mail.google.com/mail/u/0/#trash" target="_blank" rel="noreferrer">
            empty it now in Gmail
          </a>{" "}
          to reclaim the space immediately.
        </div>
      </main>

      {confirm && (
        <div className="modal-backdrop" onClick={() => !busy && setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{confirm.title}</h3>
            <p>{confirm.body}</p>
            <div className="modal-actions">
              <button className="btn" disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => {
                  const est =
                    recs.find((r) => r.title === confirm.title)?.estimatedBytes ??
                    (confirm.title.includes("selected") ? selectedBytes : estimateFromBody(confirm.body));
                  execute(confirm, est);
                }}
              >
                {busy ? "Working…" : "Move to Trash"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast">
          {toast.message}
          {toast.onUndo && (
            <button className="toast-undo" disabled={restoring !== null} onClick={toast.onUndo}>
              {restoring !== null ? "Restoring…" : "Undo"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function estimateFromBody(body: string): number {
  const m = body.match(/~([\d.]+)\s*(B|KB|MB|GB)/);
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] as "B" | "KB" | "MB" | "GB"];
  return Math.round(parseFloat(m[1]) * mult);
}

function Landing(props: {
  loading: boolean;
  error: string | null;
  onDemo: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="landing">
      <div className="landing-card">
        <div className="brand brand-big">
          <span className="brand-mark">◧</span> Gigback
        </div>
        <h1>Get your gigabytes back in minutes</h1>
        <p className="landing-sub">
          See exactly what's eating your 15 GB, then clear it in a few clicks. Runs entirely in your
          browser — your mail never touches our servers, and nothing is ever permanently deleted.
        </p>
        <ul className="landing-points">
          <li>Find huge attachments and bulk-trash by sender or category</li>
          <li>Smart cleanup suggestions from metadata only — content is never read</li>
          <li>Everything goes to Trash first: 30 days to change your mind</li>
        </ul>
        <div className="landing-actions">
          <button className="btn btn-primary" onClick={props.onConnect} disabled={props.loading}>
            Connect Gmail
          </button>
          <button className="btn" onClick={props.onDemo} disabled={props.loading}>
            {props.loading ? "Loading…" : "Try the demo"}
          </button>
        </div>
        {props.loading && <p className="landing-hint">Scanning your mailbox for large emails and senders — this can take up to 10-15 seconds on a full inbox.</p>}
        {props.error && <p className="landing-error">{props.error}</p>}
      </div>
    </div>
  );
}

function StorageBar({ quota, messagesTotal }: { quota: Overview["quota"]; messagesTotal: number }) {
  const pct = (n: number) => (quota.limitBytes ? (n / quota.limitBytes) * 100 : 0);
  const usedPct = pct(quota.usageBytes);
  const otherBytes = Math.max(
    0,
    quota.usageBytes - quota.usageInGmailBytes - quota.usageInDriveBytes - quota.usageInPhotosBytes
  );
  return (
    <section className="storage-card">
      <div className="storage-head">
        <div>
          <h2>
            {fmtBytes(quota.usageBytes)} of {fmtBytes(quota.limitBytes)} used
          </h2>
          <p className="section-sub">
            {fmtNum(messagesTotal)} emails · {Math.round(usedPct)}% full
          </p>
        </div>
        <div className={`storage-pct ${usedPct > 85 ? "storage-pct-warn" : ""}`}>{Math.round(usedPct)}%</div>
      </div>
      <div className="bar">
        <div className="bar-seg seg-gmail" style={{ width: `${pct(quota.usageInGmailBytes)}%` }} />
        <div className="bar-seg seg-drive" style={{ width: `${pct(quota.usageInDriveBytes)}%` }} />
        <div className="bar-seg seg-photos" style={{ width: `${pct(quota.usageInPhotosBytes)}%` }} />
        <div className="bar-seg seg-other" style={{ width: `${pct(otherBytes)}%` }} />
      </div>
      <div className="legend">
        <span>
          <i className="dot seg-gmail" /> Gmail {fmtBytes(quota.usageInGmailBytes)}
        </span>
        <span>
          <i className="dot seg-drive" /> Drive {fmtBytes(quota.usageInDriveBytes)}
        </span>
        {quota.usageInPhotosBytes > 0 && (
          <span>
            <i className="dot seg-photos" /> Photos {fmtBytes(quota.usageInPhotosBytes)}
          </span>
        )}
        <span>
          <i className="dot seg-free" /> Free {fmtBytes(Math.max(0, quota.limitBytes - quota.usageBytes))}
        </span>
      </div>
    </section>
  );
}

function RecCard({ rec, disabled, onRun }: { rec: Recommendation; disabled: boolean; onRun: () => void }) {
  return (
    <div className="rec-card">
      <div className="rec-top">
        <span className={`chip ${rec.confidence === "safe" ? "chip-safe" : "chip-review"}`}>
          {rec.confidence === "safe" ? "SAFE TO CLEAR" : "REVIEW FIRST"}
        </span>
        <span className="rec-bytes">≈ {fmtBytes(rec.estimatedBytes)}</span>
      </div>
      <h3>{rec.title}</h3>
      <p>{rec.detail}</p>
      <button className="btn btn-primary btn-small" disabled={disabled} onClick={onRun}>
        Clean up
      </button>
    </div>
  );
}

function RuleBuilder({
  provider,
  categories,
  busy,
  onExecute,
}: {
  provider: MailProvider;
  categories: Overview["categories"];
  busy: boolean;
  onExecute: (c: Confirm, estimatedBytes: number) => Promise<void>;
}) {
  const [olderThan, setOlderThan] = useState(365);
  const [category, setCategory] = useState("CATEGORY_PROMOTIONS");
  const [preview, setPreview] = useState<{ matched: number; estimatedBytes: number; query: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const rule: Rule = { olderThanDays: olderThan, category: category || undefined };

  return (
    <section>
      <h2>Custom cleanup rule</h2>
      <p className="section-sub">Preview first — nothing runs without your confirmation.</p>
      <div className="rule-card">
        <div className="rule-row">
          <label>
            Older than
            <select value={olderThan} onChange={(e) => { setOlderThan(Number(e.target.value)); setPreview(null); }}>
              <option value={90}>3 months</option>
              <option value={180}>6 months</option>
              <option value={365}>1 year</option>
              <option value={730}>2 years</option>
              <option value={1460}>4 years</option>
            </select>
          </label>
          <label>
            Category
            <select value={category} onChange={(e) => { setCategory(e.target.value); setPreview(null); }}>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label} ({fmtNum(c.count)})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="rule-actions">
          <button
            className="btn"
            disabled={previewing || busy}
            onClick={async () => {
              setPreviewing(true);
              try {
                setPreview(await provider.previewRule(rule));
              } finally {
                setPreviewing(false);
              }
            }}
          >
            {previewing ? "Counting…" : "Preview"}
          </button>
          {preview && (
            <button
              className="btn btn-danger"
              disabled={busy || preview.matched === 0}
              onClick={() =>
                onExecute(
                  {
                    title: `Trash ${fmtNum(preview.matched)} matching emails?`,
                    body: `Query: ${preview.query}. Estimated ~${fmtBytes(preview.estimatedBytes)}. Recoverable from Trash for 30 days.`,
                    run: () => provider.runRule(rule),
                  },
                  preview.estimatedBytes
                )
              }
            >
              Trash {fmtNum(preview.matched)} emails (~{fmtBytes(preview.estimatedBytes)})
            </button>
          )}
        </div>
        {preview && (
          <p className="rule-query">
            Gmail query: <code>{preview.query}</code>
          </p>
        )}
      </div>
    </section>
  );
}
