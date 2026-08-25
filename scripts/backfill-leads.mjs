#!/usr/bin/env node
/**
 * backfill-leads.mjs — move the Master Client List sheet into `accounts`.
 *
 * This script does NOT talk to Google. The sheet lives behind service-account
 * impersonation owned by the `leads` skill, and giving this app those
 * credentials would put a second copy of them on every machine that clones it.
 * Export first, import second:
 *
 *   cd ~/os/skills/leads && set -a && . ./.env && set +a
 *   ./.venv/bin/python sheets.py read "$BCNS_SHEET" > /tmp/leads.json
 *
 *   cd ~/bcns-internal
 *   npm run backfill-leads -- /tmp/leads.json            # dry run
 *   npm run backfill-leads -- /tmp/leads.json --apply    # writes
 *
 * Run through `tsx`, not bare `node`: this imports the .ts mapping layer, and
 * node cannot load it. The npm script above is the supported entry point.
 *
 * DRY RUN IS THE DEFAULT. This points at whatever SUPABASE_URL is configured,
 * which in normal use is production, so writing has to be asked for.
 *
 * INSERT-ONLY BY DEFAULT. An account already in Postgres is left alone. The
 * sheet carries no funnel history (no call counts, no deal values), so an
 * unconditional upsert would overwrite real contact history with blanks — the
 * one outcome this job must never produce. Pass --refresh to also update the
 * identity columns (rating, review_count, phone, website...) on existing rows;
 * that path never touches a funnel column.
 *
 * Uses the service-role key, which BYPASSES RLS. That is correct for an admin
 * backfill run by hand from a terminal, and wrong for anything the app serves.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { toAccounts } from "../lib/leads-import.ts";

/** Columns safe to refresh from the sheet: Places facts and bcns's scoring. */
const IDENTITY_COLUMNS = [
  "business_name", "business_type", "city", "phone", "website",
  "has_website", "rating", "review_count", "lead_score", "score_reason",
  "source_query", "notes",
];

function loadEnv() {
  // .env.local is not loaded automatically outside `next`, and this runs as a
  // plain node script. Parsed by hand rather than adding a dotenv dependency.
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, k, rawV] = m;
      if (process.env[k] !== undefined) continue; // a real env var always wins
      process.env[k] = rawV.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Absent .env.local is fine when the values come from the environment.
  }
}

function die(msg) {
  console.error(`backfill-leads: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const refresh = args.includes("--refresh");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) die("usage: backfill-leads.mjs <sheet.json> [--apply] [--refresh]");

  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) die("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");

  let sheet;
  try {
    sheet = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`could not read ${path}: ${e.message}`);
  }
  if (!Array.isArray(sheet)) die(`${path} is not a JSON array of rows`);

  const { rows, errors } = toAccounts(sheet);
  console.log(`read ${sheet.length} sheet rows -> ${rows.length} mappable, ${errors.length} rejected`);
  for (const e of errors) console.error(`  reject: ${e}`);
  // A row that will not map is a cell someone must fix in the sheet. Importing
  // the other 44 and saying nothing is how a lead silently disappears.
  if (errors.length && apply) die("fix the rejected rows in the sheet, then re-run");
  if (!rows.length) return;

  const db = createClient(url, key, { auth: { persistSession: false } });

  // Read the existing ids in one query rather than probing per row.
  const ids = rows.map((r) => r.place_id);
  const { data: existing, error: readErr } = await db
    .from("accounts").select("place_id").in("place_id", ids);
  if (readErr) die(`could not read existing accounts: ${readErr.message}`);
  const have = new Set((existing ?? []).map((r) => r.place_id));

  const fresh = rows.filter((r) => !have.has(r.place_id));
  const known = rows.filter((r) => have.has(r.place_id));
  console.log(`  ${fresh.length} new, ${known.length} already in the database`);

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to insert.");
    for (const r of fresh.slice(0, 5)) console.log(`  + ${r.business_name} (${r.city ?? "?"}) ${r.status}`);
    if (fresh.length > 5) console.log(`  ... and ${fresh.length - 5} more`);
    if (known.length && !refresh) console.log(`  ${known.length} existing rows would be left untouched`);
    return;
  }

  if (fresh.length) {
    const { error } = await db.from("accounts").insert(fresh);
    if (error) die(`insert failed: ${error.message}`);
    console.log(`inserted ${fresh.length} accounts`);
  }

  if (refresh && known.length) {
    let n = 0;
    for (const row of known) {
      const patch = Object.fromEntries(IDENTITY_COLUMNS.map((c) => [c, row[c]]));
      const { error } = await db.from("accounts").update(patch).eq("place_id", row.place_id);
      if (error) die(`refresh of ${row.business_name} failed: ${error.message}`);
      n += 1;
    }
    console.log(`refreshed identity columns on ${n} existing accounts`);
  } else if (known.length) {
    console.log(`left ${known.length} existing accounts untouched (pass --refresh to update identity columns)`);
  }
}

main().catch((e) => die(e?.message ?? String(e)));
