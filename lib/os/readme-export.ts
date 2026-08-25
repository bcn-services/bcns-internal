/**
 * readme-export.ts — Supabase → `<osDir>/clients/<slug>/README.md` frontmatter.
 *
 * STRICTLY ONE-WAY. Supabase is authoritative; the README is an export target.
 * Nothing in this file ever reads a value OUT of the file to use as data. It
 * opens the file for exactly one reason: to find the two marker lines so it can
 * put the generated block back between them and leave every other byte alone.
 * That is a splice, not an input.
 *
 * THE TARGET IS INJECTED, ALWAYS — `osDir` is a parameter, defaulting to
 * `OS_DIR` and to nothing else. There is deliberately no `~/os` fallback here,
 * for the same reason lib/agent/verbs/os_publish.ts has none: a writer that
 * defaults to a real repo is a writer whose test suite eventually commits to
 * it. Unconfigured is `not_configured`, never "guess".
 *
 * THE MARKERS LIVE INSIDE THE YAML FRONTMATTER, as YAML comments, and the
 * search for them is CONFINED to the frontmatter region — the span between the
 * opening `---` and the first `---` line after it. That confinement is what
 * makes the awkward cases uninteresting rather than dangerous: prose that
 * happens to contain the delimiter string, a code fence, CRLF, trailing
 * whitespace and unicode are all in the body, and the body is never searched,
 * never parsed and never rewritten. It comes back byte-identical because it is
 * carried across by `raw.slice()`, not by re-serialising anything.
 *
 * A README WITH NO MARKERS IS REFUSED, not repaired. Somebody's hand-written
 * index is not something this job should retrofit at 3am unattended.
 *
 * MONEY IS NEVER SELECTED. `monthly_rate_cents` is absent from
 * CLIENT_COLUMNS, so there is no rate in memory to leak into a tracked file,
 * and a NULL rate exports as an absent field for free — there is no branch that
 * could turn it into a `0`. The four clients whose rate is deliberately NULL
 * are indistinguishable here from the ones that have one, which is the point.
 *
 * NOTHING IS DERIVED FROM THE WALL CLOCK. `last_active` comes off the row, not
 * off `new Date()`, and no generated-at stamp is written. Two runs over
 * unchanged data therefore produce byte-identical files, which is what makes
 * "no diff on the second run" a property rather than a hope.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/* ----------------------------------------------------------------- markers -- */

/** Exact-match lines. Compared trimmed, written verbatim. */
export const MARKER_BEGIN =
  "# --- bcns:generated — written from Supabase. Do not edit inside this block. ---";
export const MARKER_END = "# --- bcns:end ---";

/**
 * Every key in `clients/_TEMPLATE.md`'s frontmatter, in its order.
 *
 * `repo` and `repo_note` are alternatives, per the template's own note: a
 * client with no local clone carries `repo_note` in place of `repo`.
 */
export const TEMPLATE_KEYS = [
  "name",
  "status",
  "priority",
  "last_active",
  "next_step",
  "repo",
  "github",
  "summary",
  "tags",
] as const;

/* -------------------------------------------------------------- the source -- */

/**
 * The columns read from `clients`. `monthly_rate_cents` is not here and must
 * never be added — see the header. tests/readme-export.test.mjs asserts on this
 * string, so adding it fails the suite rather than shipping quietly.
 */
export const CLIENT_COLUMNS =
  "slug, status, domain, repo, droplet_host, launch_date, churn_date, notes, updated_at, account_id";

/** The columns read from `accounts`. `deal_value_cents` is money; not here. */
export const ACCOUNT_COLUMNS = "id, business_name, business_type, city";

export interface ClientRow {
  slug: string;
  status: string;
  domain: string | null;
  repo: string | null;
  droplet_host: string | null;
  launch_date: string | null;
  churn_date: string | null;
  notes: string | null;
  updated_at: string;
  account_id: string;
}

export interface AccountRow {
  id: string;
  business_name: string;
  business_type: string | null;
  city: string | null;
}

/* ------------------------------------------------------------- derivations -- */

/**
 * `clients.status` → the template's vocabulary. The two enumerations are not
 * the same set and there is no column that holds the template's, so this is the
 * mapping, written once and in one place rather than inline at the call site.
 *
 * `churned` → `complete`: the engagement is over. It is the only value in the
 * template's list that means "no longer in flight", and the churn date goes
 * into `next_step` so the reason is legible rather than implied by a word.
 */
export function templateStatus(status: string): string {
  switch (status) {
    case "onboarding":
      return "in-progress";
    case "paused":
      return "on-hold";
    case "churned":
      return "complete";
    default:
      return "active";
  }
}

/** No `priority` column exists. Derived from status, deterministically. */
export function templatePriority(status: string): string {
  if (status === "active" || status === "onboarding") return "high";
  return status === "paused" ? "medium" : "low";
}

/**
 * The newest date the ROW itself knows about. Never `new Date()` — a wall-clock
 * stamp here would change the bytes on every run and break idempotency, which
 * is exactly the failure mode the item's first criterion is aimed at.
 */
export function lastActive(c: ClientRow): string {
  const dates = [c.updated_at.slice(0, 10), c.launch_date, c.churn_date].filter(
    (d): d is string => typeof d === "string" && d.length >= 10,
  );
  return dates.reduce((a, b) => (a > b ? a : b));
}

/** Operational holes worth naming. Money is not among them and never is. */
export function gaps(c: ClientRow): string[] {
  const missing: string[] = [];
  if (!c.domain?.trim()) missing.push("clients.domain");
  if (!c.repo?.trim()) missing.push("clients.repo");
  if (!c.droplet_host?.trim()) missing.push("clients.droplet_host");
  return missing;
}

/**
 * One concrete action, per the template. This is where NEW DETAIL GOES — the
 * item is explicit that the generator never appends a body section, so a gap
 * the export notices has exactly one place to surface, and this is it.
 */
export function nextStep(c: ClientRow): string {
  const missing = gaps(c);
  if (c.status === "churned") {
    return `Churned ${c.churn_date ?? "(date unrecorded)"} — archive the repo and close out the account.`;
  }
  if (c.status === "paused") {
    return "Paused — confirm with the client whether to resume or close the engagement.";
  }
  if (missing.length) {
    return `${c.status === "onboarding" ? "Onboarding" : "Live"} — fill in ${missing.join(", ")} in Supabase; the export and the health sweep both read them.`;
  }
  return c.status === "onboarding"
    ? "Onboarding — confirm the launch date and hand the site over."
    : "Live — nothing outstanding; keep the site and droplet monitored.";
}

/** First sentence of `notes`, else a line composed from the account record. */
export function summaryFor(c: ClientRow, a: AccountRow | undefined): string {
  const note = c.notes?.trim().split(/(?<=\.)\s/)[0]?.trim();
  if (note) return note;
  const trade = a?.business_type?.trim();
  const city = a?.city?.trim();
  const who = trade ? `${trade}` : "business";
  return `bcns hosted-web client — ${who}${city ? ` in ${city}` : ""}.`;
}

/** Lowercase kebab, for a tag. Empty when there is nothing usable. */
export function tagify(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A GitHub URL, or null. `clients.repo` holds `owner/name` in production
 * (0006_seed_clients.sql), but a local path is legal in the column too, so both
 * shapes are handled and anything else becomes null rather than a broken link.
 */
export function githubUrl(repo: string | null): string | null {
  const value = repo?.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return /^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}` : null;
}

/* --------------------------------------------------------------- rendering -- */

/**
 * A YAML scalar. Double-quoted via JSON.stringify for anything that could carry
 * a colon, a quote or a newline — YAML's double-quoted style takes JSON's
 * escapes, so this is correct rather than merely convenient, and it means a
 * client note containing `: ` cannot break the file it is written into.
 */
function yaml(value: string): string {
  return JSON.stringify(value.replace(/\s*\n\s*/g, " "));
}

/**
 * The generated block — the lines that go BETWEEN the markers. Key order is
 * the template's and is fixed, because "no diff on the second run" is a
 * byte comparison and an unordered object would satisfy it only by luck.
 */
export function renderBlock(c: ClientRow, a: AccountRow | undefined): string {
  const repo = c.repo?.trim() ?? "";
  const local = /^([~/]|\.\.?\/)/.test(repo);
  const url = githubUrl(c.repo);
  const tags = ["bcns-client", tagify(a?.business_type)].filter(Boolean);

  const lines = [
    `name: ${yaml(a?.business_name ? `${a.business_name} (${c.slug})` : c.slug)}`,
    `status: ${templateStatus(c.status)}`,
    `priority: ${templatePriority(c.status)}`,
    `last_active: ${lastActive(c)}`,
    `next_step: ${yaml(nextStep(c))}`,
    // The template's own rule: `repo_note` stands in for `repo` when there is
    // no local clone. The database records the GitHub path, not a path on any
    // one laptop, so most clients legitimately take the note.
    local ? `repo: ${repo}` : `repo_note: ${yaml("Remote-only — no local clone recorded in Supabase")}`,
    `github: ${url ?? "null"}`,
    `summary: ${yaml(summaryFor(c, a))}`,
    `tags: [${tags.join(", ")}]`,
  ];
  return lines.join("\n");
}

/* ----------------------------------------------------------------- splicing -- */

export type SpliceResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Find the frontmatter region: the span strictly between the opening `---`
 * line and the first `---` line after it. Returns null when the file has no
 * frontmatter at all, which is a refusal rather than something to repair.
 */
function frontmatterSpan(raw: string): { start: number; end: number } | null {
  const open = /^---[ \t]*\r?\n/.exec(raw);
  if (!open) return null;
  const start = open[0].length;
  const close = /^---[ \t]*(\r?\n|$)/m.exec(raw.slice(start));
  if (!close) return null;
  return { start, end: start + close.index };
}

/** Byte offset of a line equal (after trimming) to `marker`, within a span. */
function findMarker(raw: string, span: { start: number; end: number }, marker: string): number {
  let at = span.start;
  while (at < span.end) {
    const brk = raw.indexOf("\n", at);
    const stop = brk === -1 || brk > span.end ? span.end : brk;
    if (raw.slice(at, stop).trim() === marker) return at;
    if (stop === span.end) break;
    at = stop + 1;
  }
  return -1;
}

/**
 * Put `block` between the markers and change nothing else.
 *
 * The prose body is carried across by `raw.slice(...)` from a byte offset past
 * the frontmatter's closing `---`. It is never parsed, never re-serialised and
 * never even searched, so whatever is in it — the delimiter string as prose, a
 * code fence, CRLF, trailing whitespace, unicode — survives byte-for-byte
 * because nothing in this function can see it.
 */
export function spliceGenerated(raw: string, block: string): SpliceResult {
  const span = frontmatterSpan(raw);
  if (!span) return { ok: false, error: "no YAML frontmatter — refusing to write" };

  const begin = findMarker(raw, span, MARKER_BEGIN);
  if (begin === -1) return { ok: false, error: "no bcns:generated marker in the frontmatter — refusing to write" };
  const end = findMarker(raw, span, MARKER_END);
  if (end === -1 || end < begin) {
    return { ok: false, error: "no bcns:end marker after bcns:generated — refusing to write" };
  }

  const tail = raw.indexOf("\n", end);
  const after = tail === -1 ? raw.length : tail;
  return { ok: true, text: `${raw.slice(0, begin)}${MARKER_BEGIN}\n${block}\n${MARKER_END}${raw.slice(after)}` };
}

/** A README for a client that does not have one yet. Markers plus a stub body. */
export function newReadme(block: string, slug: string): string {
  return [
    "---",
    MARKER_BEGIN,
    block,
    MARKER_END,
    "---",
    "",
    "## Where it stands",
    "",
    `Not written yet. This paragraph is hand-maintained — the ${slug} frontmatter above`,
    "is exported from Supabase and everything below these markers is yours.",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ writing -- */

export type ExportOutcome = "created" | "updated" | "unchanged" | "refused";

export interface ExportedClient {
  slug: string;
  outcome: ExportOutcome;
  path: string;
  /** Set only when `outcome` is `refused`. */
  reason?: string;
}

/**
 * `osDir`, else `OS_DIR`, else nothing. No hard-coded `~/os`; see the header.
 */
export function resolveOsDir(osDir?: string): string {
  return (osDir ?? process.env.OS_DIR ?? "").trim();
}

/**
 * Export one client. Writes ONLY `<osDir>/clients/<slug>/README.md` — never a
 * personal-overlay path, because it never enumerates the tree and never walks
 * anything. `projects/`, personal skills and personal memory files are absent
 * on other clones and irrelevant here either way.
 *
 * The write is skipped entirely when the bytes already match, so an unchanged
 * run leaves the mtime alone as well as the content.
 */
export async function exportOne(
  osRoot: string,
  c: ClientRow,
  a: AccountRow | undefined,
): Promise<ExportedClient> {
  const path = join(osRoot, "clients", c.slug, "README.md");
  const block = renderBlock(c, a);

  let raw: string | null = null;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { slug: c.slug, outcome: "refused", path, reason: (err as Error).message };
    }
  }

  if (raw === null) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, newReadme(block, c.slug), "utf8");
    return { slug: c.slug, outcome: "created", path };
  }

  const spliced = spliceGenerated(raw, block);
  if (!spliced.ok) return { slug: c.slug, outcome: "refused", path, reason: spliced.error };
  if (spliced.text === raw) return { slug: c.slug, outcome: "unchanged", path };
  await writeFile(path, spliced.text, "utf8");
  return { slug: c.slug, outcome: "updated", path };
}

/* ---------------------------------------------------------------- the job -- */

// Type-only, so this is erased at runtime and lib/jobs.ts → lib/os/readme-export.ts
// stays a one-way arrow. Same reason lib/outreach.ts imports it this way.
import type { JobDefinition } from "../jobs";
import { os_publish } from "../agent/verbs/os_publish";
import type { Caller, DbClient } from "../agent/verbs/types";
import { dailyWindow } from "../job-windows";
import { resolveAdmin } from "../notify";

export const README_EXPORT_JOB = "readme_export";

/** git's ceiling here is os_publish's 500-char message cap. */
const MAX_ACTORS = 6;

/**
 * The commit identity. The item names it, and it is a BOT rather than a person
 * because nobody typed this commit — the actor who caused the underlying change
 * is named in the BODY instead, where it is attribution rather than a forged
 * authorship.
 */
export const BOT_AUTHOR = { name: "bcns-os-bot", email: "os-bot@bcn-services.com" };

/** Injected so a test publishes into a throwaway repo and never into a real one. */
export type Publisher = (osDir: string, message: string, db: DbClient) => Promise<{ ok: boolean; error?: string }>;

/**
 * The caller identity is the ADMIN's real profile, resolved the same way
 * lib/jobs.ts resolves it to notify — a scheduled run has no person behind it,
 * and `os_publish` is admin-only, so borrowing an identity is not optional.
 * An admin with no profile row is a refusal rather than a synthesised uuid: the
 * commit would be unattributable, and a fake id in an audit path is worse than
 * a night without an export.
 */
export const realPublisher: Publisher = async (osDir, message, db) => {
  const admin = await resolveAdmin(db);
  if (!admin.profileId) {
    return { ok: false, error: "no admin profile row to publish as" };
  }
  const caller: Caller = { profileId: admin.profileId, email: admin.email, role: "admin" };
  const res = await os_publish.run({ caller, osDir, osAuthor: BOT_AUTHOR }, { message });
  return res.ok ? { ok: true } : { ok: false, error: `${res.error.code}: ${res.error.message}` };
};

/**
 * The commit message. Subject, then the changed slugs, then attribution.
 *
 * "The real actor named in the commit body when a change traces to a person"
 * resolves to `account_activity.actor_email`, which item 4's trigger STAMPS
 * SERVER-SIDE from the JWT (0010_activity_audit_trail.sql) — it is the one
 * actor field in this schema that a client cannot forge, which is the only
 * reason it is trustworthy enough to name in a commit. No new column was
 * invented for this.
 *
 * ponytail: attribution is the newest human actor on the account, not a
 * per-field diff — this schema has no column-level history to attribute
 * against. Upgrade to per-field attribution if `clients` ever grows an audit
 * trail like `account_activity` has.
 */
export function commitMessage(changed: string[], actors: Map<string, string>): string {
  const head = `chore(os): export client README frontmatter (${changed.length} client${changed.length === 1 ? "" : "s"})`;
  const lines = [head, "", ...changed.map((s) => `- ${s}`)];
  const named = changed
    .map((s) => (actors.get(s) ? `${s}: ${actors.get(s)}` : null))
    .filter((v): v is string => v !== null)
    .slice(0, MAX_ACTORS);
  if (named.length) lines.push("", "Traces to:", ...named.map((n) => `  ${n}`));
  const message = lines.join("\n");
  return message.length > 480 ? `${message.slice(0, 477)}...` : message;
}

export interface ReadmeExportDeps {
  /** Injected, defaulting to OS_DIR. Never a hard-coded real repo. */
  osDir?: string;
  publish?: Publisher;
  /** False in tests that only want the files written. Default true. */
  commit?: boolean;
}

/**
 * The nightly export. A job in the item-9 registry, not a second runner: it
 * inherits `job_runs` claiming, the window-key idempotency and the notification
 * path unchanged, and it is idempotent a SECOND way on top of that, because an
 * unchanged run writes no bytes and commits nothing.
 */
export function readmeExportJob(deps: ReadmeExportDeps = {}): JobDefinition {
  const publish = deps.publish ?? realPublisher;
  return {
    name: README_EXPORT_JOB,
    schedule: "daily",
    window: dailyWindow,
    async run({ db }) {
      const osRoot = resolveOsDir(deps.osDir);
      if (!osRoot) {
        // Not a crash and not a silent skip. Nothing was written, and the one
        // lever a job has to say so is a finding.
        return { findings: ["readme_export: no os directory configured (set OS_DIR)"], log: "not configured" };
      }

      const clientRes = await db.from("clients").select(CLIENT_COLUMNS).order("slug");
      if (clientRes?.error) throw new Error(`clients read failed: ${clientRes.error.message}`);
      const clients = (clientRes.data ?? []) as ClientRow[];
      if (clients.length === 0) return { findings: [], log: "no clients", facts: { clients: 0 } };

      const accountIds = clients.map((c) => c.account_id);
      const acctRes = await db.from("accounts").select(ACCOUNT_COLUMNS).in("id", accountIds);
      if (acctRes?.error) throw new Error(`accounts read failed: ${acctRes.error.message}`);
      const accounts = new Map(((acctRes.data ?? []) as AccountRow[]).map((a) => [a.id, a]));

      const results: ExportedClient[] = [];
      for (const c of clients) results.push(await exportOne(osRoot, c, accounts.get(c.account_id)));

      const changed = results.filter((r) => r.outcome === "created" || r.outcome === "updated");
      const refused = results.filter((r) => r.outcome === "refused");

      let commit = "nothing changed; no commit";
      if (changed.length && deps.commit !== false) {
        const actors = await newestActors(db, clients, changed.map((r) => r.slug));
        const res = await publish(osRoot, commitMessage(changed.map((r) => r.slug), actors), db);
        commit = res.ok ? "committed via os_publish" : `os_publish failed: ${res.error}`;
        if (!res.ok) refused.push({ slug: "(commit)", outcome: "refused", path: osRoot, reason: res.error });
      }

      return {
        // A refusal is the only finding. A README somebody stripped the markers
        // out of, or a commit that did not land, is a thing a human must look
        // at; an unchanged client is not.
        findings: refused.map((r) => `${r.slug}: ${r.reason}`),
        log: [...results.map((r) => `${r.slug}: ${r.outcome}${r.reason ? ` — ${r.reason}` : ""}`), commit].join("\n"),
        facts: {
          clients: clients.length,
          changed: changed.length,
          unchanged: results.filter((r) => r.outcome === "unchanged").length,
          refused: refused.length,
        },
      };
    },
  };
}

/** Newest non-null `actor_email` per changed slug. Best effort — a missing
 *  directory costs a name in the commit body, never the commit. */
async function newestActors(
  db: DbClient,
  clients: ClientRow[],
  changed: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = new Set(changed);
  const byAccount = new Map(clients.filter((c) => wanted.has(c.slug)).map((c) => [c.account_id, c.slug]));
  if (byAccount.size === 0) return out;
  try {
    const res = await db
      .from("account_activity")
      .select("account_id, actor_email, occurred_at")
      .in("account_id", [...byAccount.keys()]);
    if (res?.error) return out;
    const seen = new Map<string, string>();
    for (const row of (res.data ?? []) as { account_id: string; actor_email: string | null; occurred_at: string }[]) {
      if (!row.actor_email) continue;
      const slug = byAccount.get(row.account_id);
      if (!slug) continue;
      const prev = seen.get(slug);
      if (prev === undefined || row.occurred_at > prev) {
        seen.set(slug, row.occurred_at);
        out.set(slug, row.actor_email);
      }
    }
  } catch {
    return out;
  }
  return out;
}
