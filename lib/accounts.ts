/**
 * accounts.ts — Data layer for accounts (leads), clients, and activity.
 *
 * Platform rule (same as coventry's lib/jobs.ts): every function takes an
 * INJECTED Supabase client. This module reads no env, imports no `server-only`,
 * and constructs no client, so it stays keyless and testable with a fake.
 *
 * Authorization note: this layer does NOT check the caller's role. RLS in
 * supabase/migrations/0002_rls_policies.sql is the enforcement point, and the
 * route gate (lib/auth.ts) is the second. A member's client-write attempt fails
 * at the database, not here — proven in tests/rls-policies.test.mjs.
 */

/** The eight funnel stages. Order is the funnel order; the DB CHECK matches. */
export const STAGES = [
  "prospect",
  "attempted",
  "reached",
  "consult_scheduled",
  "consult_done",
  "won",
  "lost",
  "dead",
] as const;
export type Stage = (typeof STAGES)[number];

/** Stages that end the funnel. Nothing advances out of these without intent. */
export const TERMINAL_STAGES: readonly Stage[] = ["won", "lost", "dead"];

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const isStage = (v: unknown): v is Stage =>
  typeof v === "string" && (STAGES as readonly string[]).includes(v);

/** Client slug rule, kept identical to the DB CHECK in 0001_core_schema.sql. */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isValidSlug = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 63 && SLUG_RE.test(v);

/** Derive a legal slug from a business name. Returns null if nothing survives. */
export function slugify(name: string): string | null {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return isValidSlug(s) ? s : null;
}

/**
 * Dollars → integer cents. House rule: money is bigint cents everywhere.
 * Parsed as a string to dodge float error (24.99 * 100 === 2498.9999…).
 */
export function dollarsToCents(dollars: string | number): number {
  const raw = String(dollars).trim().replace(/[$,]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new InvalidInputError(`not a money amount: ${dollars}`);
  }
  const neg = raw.startsWith("-");
  const [whole, frac = ""] = raw.replace(/^-/, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -cents : cents;
}

/** Cents → a display string. No currency symbol; the view adds it. */
export const centsToDollars = (cents: number): string =>
  (cents < 0 ? "-" : "") + (Math.abs(cents) / 100).toFixed(2);

export interface Account {
  id: string;
  place_id: string | null;
  business_name: string;
  business_type: string | null;
  city: string | null;
  phone: string | null;
  website: string | null;
  has_website: boolean | null;
  rating: number | null;
  review_count: number | null;
  lead_score: number | null;
  score_reason: string | null;
  status: Stage;
  call_count: number;
  last_contact: string | null;
  contact_name: string | null;
  last_outcome: string | null;
  consult_date: string | null;
  close_date: string | null;
  deal_value_cents: number | null;
  source_query: string | null;
  date_added: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  account_id: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const ACCOUNT_COLUMNS =
  "id, place_id, business_name, business_type, city, phone, website, has_website, rating, review_count, lead_score, score_reason, status, call_count, last_contact, contact_name, last_outcome, consult_date, close_date, deal_value_cents, source_query, date_added, notes, created_at, updated_at";
const CLIENT_COLUMNS = "id, account_id, slug, status, created_at, updated_at";

/** Structural shape of the query builder used here — see lib/jobs.ts rationale. */
interface Result<T> {
  data: T | null;
  error: { message: string } | null;
}
type Client_ = {
  from(table: string): any;
};

function unwrap<T>(res: Result<T>, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data`);
  return res.data;
}

/** All accounts, newest first. RLS decides which rows come back. */
export async function listAccounts(
  db: Client_,
  opts: { status?: Stage } = {},
): Promise<Account[]> {
  // Validate BEFORE touching the client, so a bad filter never issues a query.
  if (opts.status !== undefined && !isStage(opts.status)) {
    throw new InvalidInputError(`bad status: ${opts.status}`);
  }
  let q = db.from("accounts").select(ACCOUNT_COLUMNS);
  if (opts.status !== undefined) q = q.eq("status", opts.status);
  return unwrap<Account[]>(await q.order("created_at", { ascending: false }), "listAccounts");
}

export async function getAccount(db: Client_, id: string): Promise<Account | null> {
  if (!isUuid(id)) throw new InvalidInputError(`bad account id: ${id}`);
  const res: Result<Account> = await db
    .from("accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (res.error) throw new Error(`getAccount: ${res.error.message}`);
  return res.data ?? null;
}

/** Move an account through the funnel. Rejects an unknown stage before the DB. */
export async function setAccountStatus(
  db: Client_,
  id: string,
  status: Stage,
): Promise<Account> {
  if (!isUuid(id)) throw new InvalidInputError(`bad account id: ${id}`);
  if (!isStage(status)) throw new InvalidInputError(`bad status: ${status}`);
  return unwrap<Account>(
    await db.from("accounts").update({ status }).eq("id", id).select(ACCOUNT_COLUMNS).single(),
    "setAccountStatus",
  );
}

/** Append one contact record. This is the history the lead sheet could not keep. */
export async function logActivity(
  db: Client_,
  input: { accountId: string; kind: string; note?: string | null; actor?: string | null },
): Promise<void> {
  if (!isUuid(input.accountId)) throw new InvalidInputError(`bad account id: ${input.accountId}`);
  if (!input.kind?.trim()) throw new InvalidInputError("activity kind is required");
  const res: Result<unknown> = await db.from("account_activity").insert({
    account_id: input.accountId,
    kind: input.kind.trim(),
    note: input.note ?? null,
    actor: input.actor ?? null,
  });
  if (res.error) throw new Error(`logActivity: ${res.error.message}`);
}

export async function listClients(db: Client_): Promise<Client[]> {
  return unwrap<Client[]>(
    await db.from("clients").select(CLIENT_COLUMNS).order("slug", { ascending: true }),
    "listClients",
  );
}

export async function getClientBySlug(db: Client_, slug: string): Promise<Client | null> {
  if (!isValidSlug(slug)) throw new InvalidInputError(`bad slug: ${slug}`);
  const res: Result<Client> = await db
    .from("clients")
    .select(CLIENT_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();
  if (res.error) throw new Error(`getClientBySlug: ${res.error.message}`);
  return res.data ?? null;
}

/**
 * Convert a won account into a client. Admin-only in practice: RLS has no
 * member INSERT policy on `clients`, so a member's call fails at the database.
 *
 * ponytail: two statements, not a transaction — a stored procedure would make
 * it atomic. Worst case is an account marked `won` with no client row, which
 * the client list makes obvious and a re-run fixes. Upgrade to an RPC if that
 * inconsistency ever actually bites.
 */
export async function convertAccountToClient(
  db: Client_,
  input: { accountId: string; slug?: string; dealValueDollars?: string | number },
): Promise<Client> {
  const account = await getAccount(db, input.accountId);
  if (!account) throw new InvalidInputError(`no such account: ${input.accountId}`);

  const slug = input.slug ?? slugify(account.business_name);
  if (!isValidSlug(slug)) {
    throw new InvalidInputError(`cannot derive a slug from "${account.business_name}"`);
  }

  const patch: Record<string, unknown> = { status: "won" satisfies Stage };
  if (input.dealValueDollars !== undefined) {
    patch.deal_value_cents = dollarsToCents(input.dealValueDollars);
  }
  if (!account.close_date) patch.close_date = new Date().toISOString().slice(0, 10);

  const upd: Result<unknown> = await db.from("accounts").update(patch).eq("id", account.id);
  if (upd.error) throw new Error(`convertAccountToClient (account): ${upd.error.message}`);

  return unwrap<Client>(
    await db
      .from("clients")
      .insert({ account_id: account.id, slug, status: "active" })
      .select(CLIENT_COLUMNS)
      .single(),
    "convertAccountToClient (client)",
  );
}
