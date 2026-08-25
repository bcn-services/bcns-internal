/**
 * search_places — a wrapper around the EXISTING lead-discovery script.
 *
 * `~/os/skills/leads/places.py` already does this correctly: it authenticates
 * with ADC, asks Google Cloud Monitoring how many Places calls the project has
 * actually made this month, refuses to spend past the cap, re-checks the budget
 * inside its paging loop, and requests a narrow field mask so a call never
 * silently upgrades to the expensive SKU. None of that is reimplemented here
 * and none of it should be — a second copy of a budget guard is a second thing
 * that can be wrong about money.
 *
 * ADMIN ONLY. Every call spends against a shared monthly cap.
 *
 * The script prints JSON to stdout and its budget commentary to stderr, so the
 * parse is a plain JSON.parse of stdout. A non-zero exit is the script refusing
 * to spend (or Google refusing to answer); its message is passed through rather
 * than flattened, because "monthly Places cap reached: 950/950" is exactly what
 * the caller needs to read.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { osDir } from "../../os/paths";
import { defineVerb, fail, ok, type VerbResult } from "./types";

const execFileAsync = promisify(execFile);

const DEFAULT_COUNT = 20;
const MAX_COUNT = 60;
const TIMEOUT_MS = 120_000;

export interface SearchPlacesInput {
  query: string;
  count?: number;
}

/** One row exactly as places.py emits it — deliberately not renamed. */
export interface PlaceRow {
  place_id: string;
  business_name: string;
  type: string;
  city: string;
  phone: string;
  website: string;
  has_website: string;
  rating: number | string;
  review_count: number | string;
  source_query: string;
  date_added: string;
  [k: string]: unknown;
}

export const search_places = defineVerb<SearchPlacesInput, PlaceRow[]>({
  name: "search_places",
  description:
    "Admin only. Find businesses via Google Places using the existing bcns leads script, which " +
    "enforces its own monthly spend cap. Returns rows in the lead-sheet shape, not yet saved.",
  roles: ["admin"],
  properties: {
    query: {
      type: "string",
      description: "Free-text search, e.g. 'plumbers in Providence RI'.",
    },
    count: { type: "integer", description: `How many leads (default ${DEFAULT_COUNT}, cap ${MAX_COUNT}).` },
  },
  required: ["query"],
  async handler(ctx, input): Promise<VerbResult<PlaceRow[]>> {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return fail("invalid_input", "search_places needs a query");

    const count =
      typeof input.count === "number" && Number.isFinite(input.count) && input.count > 0
        ? Math.min(Math.floor(input.count), MAX_COUNT)
        : DEFAULT_COUNT;

    const python = ctx.places?.python ?? "python3";
    const script = ctx.places?.script ?? join(osDir(), "skills", "leads", "places.py");

    let stdout: string;
    try {
      // argv array, never a shell string: `query` comes from a model and would
      // otherwise be one backtick away from command execution.
      const r = await execFileAsync(python, [script, "search", query, "--count", String(count)], {
        env: placesEnv() as NodeJS.ProcessEnv,
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = r.stdout;
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string; code?: unknown };
      const detail = (e.stderr || e.message || String(err)).trim();
      if (e.code === "ENOENT") {
        return fail("not_configured", `search_places: cannot run ${python} ${script} — ${detail}`);
      }
      return fail("internal", `search_places: ${detail}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return fail("internal", "search_places: the places script did not return JSON");
    }
    if (!Array.isArray(parsed)) return fail("internal", "search_places: expected a JSON array");
    return ok(parsed as PlaceRow[]);
  },
});

/**
 * The child gets an allowlist, for the same reason lib/agent/runner.ts builds
 * one: `process.env` on this server holds SUPABASE_SERVICE_ROLE_KEY,
 * AGENT_TOKEN_KEY and DATABASE_URL, and a lead-search subprocess has no
 * business being handed any of them. Only what google-auth and the script's
 * own budget guard need crosses over.
 */
function placesEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const name of [
    "HOME",
    "LANG",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_CONFIG",
    "BCNS_PROJECT",
    "BCNS_PLACES_MONTHLY_CAP",
  ]) {
    const v = process.env[name];
    if (v) env[name] = v;
  }
  return env;
}
