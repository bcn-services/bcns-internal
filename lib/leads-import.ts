/**
 * leads-import.ts — the sheet row -> `accounts` row mapping, and nothing else.
 *
 * Pure on purpose. The Google side of this job lives in the `leads` skill under
 * `~/os/skills/leads`, which owns the service-account impersonation and the
 * gitignored `.env`. This app never holds Sheets credentials: the skill exports
 * JSON, this module maps it, and `scripts/backfill-leads.mjs` writes it. Keeping
 * the mapping pure is what lets it be tested without a network or a database.
 *
 * The sheet is a spreadsheet, so every cell arrives as a string, including the
 * blanks. "" is not a value; it means the human never filled the cell in. Every
 * coercion below turns "" into null rather than into 0, false, or "".
 */

/** Sheet column order is `COLUMNS` in ~/os/skills/leads/sheets.py. */
export type SheetRow = Record<string, unknown>;

/** Mirrors the CHECK on accounts.status in 0001_core_schema.sql. */
export const STATUSES = [
  "new", "attempted", "reached", "consult_scheduled",
  "consult_done", "won", "lost", "dead",
] as const;
export type Status = (typeof STATUSES)[number];

export class LeadImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadImportError";
  }
}

const str = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** "" -> null. Everything reaching the database distinguishes blank from set. */
function text(v: unknown): string | null {
  const s = str(v);
  return s === "" ? null : s;
}

/**
 * "yes"/"no" -> boolean. The sheet is hand-edited, so accept the obvious
 * spellings and refuse anything else rather than silently reading a typo as
 * false — has_website drives who is worth calling.
 */
function bool(v: unknown, field: string): boolean | null {
  const s = str(v).toLowerCase();
  if (s === "") return null;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  throw new LeadImportError(`${field}: expected yes/no, got ${JSON.stringify(v)}`);
}

function int(v: unknown, field: string, min: number, max: number): number | null {
  const s = str(v);
  if (s === "") return null;
  // Reject "3.7" outright: a silent trunc to 3 is a wrong number that looks right.
  if (!/^-?\d+$/.test(s)) {
    throw new LeadImportError(`${field}: expected a whole number, got ${JSON.stringify(v)}`);
  }
  const n = Number(s);
  if (n < min || n > max) {
    throw new LeadImportError(`${field}: ${n} is outside ${min}..${max}`);
  }
  return n;
}

/** rating is numeric(2,1) 0..5. One decimal place, so a string round-trips exactly. */
function rating(v: unknown): number | null {
  const s = str(v);
  if (s === "") return null;
  if (!/^\d(?:\.\d)?$/.test(s)) {
    throw new LeadImportError(`rating: expected 0..5 with at most one decimal, got ${JSON.stringify(v)}`);
  }
  const n = Number(s);
  if (n < 0 || n > 5) throw new LeadImportError(`rating: ${n} is outside 0..5`);
  return n;
}

/**
 * Dates are `date` columns. Only an unambiguous ISO day is accepted — "8/19/26"
 * is read differently on two continents, and guessing is how a close date lands
 * in the wrong month.
 */
function date(v: unknown, field: string): string | null {
  const s = str(v);
  if (s === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new LeadImportError(`${field}: expected YYYY-MM-DD, got ${JSON.stringify(v)}`);
  }
  // The regex above already fixed the shape, so these three are present; the
  // Number() round-trip is what catches 2026-02-30, which matches the regex.
  const parts = s.split("-").map(Number) as [number, number, number];
  const [y, m, d] = parts;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new LeadImportError(`${field}: ${s} is not a real calendar date`);
  }
  return s;
}

/**
 * Money -> integer cents, parsed off the DIGITS, never through parseFloat.
 * `Math.round(12.55 * 100)` is 1255 today and a rounding argument tomorrow;
 * reading "12.55" as 12 and 55 cannot drift. Accepts "$1,200" and "1200.00".
 */
export function toCents(v: unknown): number | null {
  const s = str(v).replace(/[$,\s]/g, "");
  if (s === "") return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new LeadImportError(`deal_value: expected a dollar amount, got ${JSON.stringify(v)}`);
  const cents = (m[2] ?? "").padEnd(2, "0");
  return Number(m[1]) * 100 + Number(cents);
}

function status(v: unknown): Status {
  const s = str(v).toLowerCase();
  // A blank status is the sheet's own default for a freshly-scraped lead, and
  // the column is NOT NULL, so blank means 'new' rather than an import failure.
  if (s === "") return "new";
  if (!(STATUSES as readonly string[]).includes(s)) {
    throw new LeadImportError(`status: ${JSON.stringify(v)} is not one of ${STATUSES.join(", ")}`);
  }
  return s as Status;
}

/** The columns this importer owns. Everything else on `accounts` is bcns's own. */
export type AccountInsert = {
  place_id: string;
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
  status: Status;
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
};

/**
 * One sheet row -> one account row. Throws LeadImportError with the business
 * name attached, because "row 34 is bad" sends you counting rows in a browser.
 */
export function toAccount(row: SheetRow): AccountInsert {
  const name = str(row.business_name);
  const placeId = str(row.place_id);
  // place_id is the identity this import upserts on. Without it a re-run would
  // insert the same business again, so it is a hard requirement, not a default.
  if (!placeId) throw new LeadImportError(`place_id is empty (business_name: ${JSON.stringify(name)})`);
  if (!name) throw new LeadImportError(`business_name is empty (place_id: ${placeId})`);

  try {
    return {
      place_id: placeId,
      business_name: name,
      // The sheet calls it `type`; the column is `business_type` because `type`
      // is awkward in SQL. Renamed here so the rest of the app never sees it.
      business_type: text(row.type),
      city: text(row.city),
      phone: text(row.phone),
      website: text(row.website),
      has_website: bool(row.has_website, "has_website"),
      rating: rating(row.rating),
      review_count: int(row.review_count, "review_count", 0, 100_000_000),
      lead_score: int(row.lead_score, "lead_score", 0, 100),
      score_reason: text(row.score_reason),
      status: status(row.status),
      call_count: int(row.call_count, "call_count", 0, 100_000) ?? 0,
      last_contact: date(row.last_contact, "last_contact"),
      contact_name: text(row.contact_name),
      last_outcome: text(row.last_outcome),
      consult_date: date(row.consult_date, "consult_date"),
      close_date: date(row.close_date, "close_date"),
      deal_value_cents: toCents(row.deal_value),
      source_query: text(row.source_query),
      date_added: date(row.date_added, "date_added"),
      notes: text(row.notes),
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new LeadImportError(`${name} (${placeId}): ${why}`);
  }
}

export type MapResult = { rows: AccountInsert[]; errors: string[] };

/**
 * Maps every row, collecting failures instead of stopping at the first one. A
 * spreadsheet usually has several bad cells, and fixing them one run per cell
 * is how an import gets abandoned half-done.
 */
export function toAccounts(sheet: SheetRow[]): MapResult {
  const rows: AccountInsert[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const raw of sheet) {
    let row: AccountInsert;
    try {
      row = toAccount(raw);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    // A place_id twice in one batch would make the upsert's outcome depend on
    // row order. Report it; do not let the later row quietly win.
    const prior = seen.get(row.place_id);
    if (prior !== undefined) {
      errors.push(`${row.business_name} (${row.place_id}): duplicate place_id, already used by ${prior}`);
      continue;
    }
    seen.set(row.place_id, row.business_name);
    rows.push(row);
  }
  return { rows, errors };
}
