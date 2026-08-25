/**
 * job-windows.ts — the window keys, in the one place both sides can import.
 *
 * Another leaf module with no imports, and it exists for a structural reason:
 * lib/jobs.ts owns the registry and therefore imports lib/outreach.ts, while
 * lib/outreach.ts needs only these two functions back. That was a RUNTIME
 * CYCLE, and it stood up only because every reference across it happened to be
 * inside a function body — one top-level `const REGISTRY = jobRegistry()` or one
 * top-level use of `dailyWindow` and one side initialises as `undefined`.
 *
 * With the windows here the arrow points one way: jobs.ts → outreach.ts →
 * job-windows.ts. lib/jobs.ts re-exports both names, so nothing that already
 * imports them from there has to change.
 */

/**
 * The label a job gives to "this occurrence". Two invocations that should
 * collapse into one MUST produce the same string; see 0014_job_windows.sql.
 */
export type WindowKey = (now: Date) => string;

/** UTC calendar day. Two runs on the same date are the same run. */
export const dailyWindow: WindowKey = (now) => now.toISOString().slice(0, 10);

/**
 * A fixed seven-day bucket counted from the Unix epoch.
 *
 * Deliberately NOT the ISO week: ISO weeks have a year-boundary rule that is
 * easy to get subtly wrong, and nothing here needs a window a human recognises
 * — it needs a string two invocations agree on. Epoch weeks are one expression
 * with no edge cases.
 */
export const weeklyWindow: WindowKey = (now) => `w${Math.floor(now.getTime() / 604_800_000)}`;
