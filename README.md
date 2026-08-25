# Gigback

Reclaim your Gmail storage in minutes. Privacy-first: the app runs entirely in your
browser and talks directly to Google's APIs — mail data never touches a Gigback server
(there isn't one), and nothing is ever permanently deleted (trash-only, 30-day recovery).

## Architecture decisions (v1)

- **Local-first**: browser → Gmail REST API directly, via Google Identity Services token flow.
  No backend proxies mail. A thin backend may be added later for billing/licensing only.
- **Trash-only**: uses `gmail.modify` + `messages.batchModify` to add the `TRASH` label.
  Never `batchDelete` (which would require the full `mail.google.com` scope).
- **Metadata-only triage**: cleanup recommendations are computed from sender, subject-line
  patterns, size, age, and category — message bodies are never fetched.
- **On-demand, not autonomous**: no server means no scheduled background cleanup. This is
  a deliberate v1 trade-off.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click **Try the demo** — no credentials needed.

## Connect a real Gmail account

1. Create a project at https://console.cloud.google.com and enable the **Gmail API** and **Google Drive API**.
2. Configure the OAuth consent screen (External). While in **Testing** status you can add up
   to 100 test users with no verification.
3. Create an **OAuth client ID → Web application**, add `http://localhost:5173` to
   *Authorized JavaScript origins*.
4. Copy `.env.example` to `.env` and set `VITE_GOOGLE_CLIENT_ID`.
5. `npm run dev`, click **Connect Gmail**.

Scopes requested: `gmail.modify` (trash mail), `drive.metadata.readonly` (storage quota).

## Going to production (later)

- Both scopes above are **restricted**: publishing beyond 100 test users requires Google's
  restricted-scope verification including an annual CASA Tier 2 security assessment
  (~$500–1,000/yr via Google's discounted lab). Do not pay this before traction is proven.
- Client-side-only architecture simplifies the assessment but does not exempt you from it.
- Trashed mail frees quota only after Trash is emptied (30 days automatic, or manual) — the
  UI must stay honest about this.
