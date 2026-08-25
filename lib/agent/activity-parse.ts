/**
 * activity-parse.ts — turning "called Mike at Coventry Tuesday" into a row.
 *
 * TWO LAYERS, AND THE SPLIT IS THE WHOLE POINT.
 *
 *   Layer A  — build the prompt, hand it to lib/agent/runner.ts. Lives in
 *              verbs/log_activity.ts, because that is where the injected
 *              runner arrives.
 *   Layer B  — THIS FILE. Pure. It takes the model's reply plus `{now,
 *              timeZone}` and produces a candidate row or a typed failure. No
 *              clock, no network, no env: everything it needs is a parameter.
 *
 * A model call is not reproducible, so nothing that matters may depend on one.
 * Every rule worth getting right — which kinds are allowed, what "Tuesday"
 * means, what happens when the reply is garbage — is decided here, where a
 * test can drive it with a canned string.
 *
 * THE DATE RULE. A relative date resolves against the SUBMITTER'S LOCAL
 * CALENDAR DATE, never UTC's. At 18:00 in Los Angeles the UTC date is already
 * tomorrow; resolving "yesterday" off UTC would land a day late, and "Tuesday"
 * could land a whole week off when the local day is Monday and UTC's is
 * Tuesday. So the local date is derived from `timeZone` first, all weekday
 * arithmetic runs on that calendar date as plain integers, and only the last
 * step converts back to an instant.
 */

import { HUMAN_KINDS, type ActivityKind } from "./verbs/activity_query";

/* ------------------------------------------------------------ timezones -- */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** IANA zone names only. An unknown one makes Intl throw, so it is checked once. */
export function safeZone(timeZone: string | null | undefined): string {
  const tz = (timeZone ?? "").trim();
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The wall clock an observer in `timeZone` reads off `instant`.
 *
 * `hourCycle: "h23"` rather than `hour12: false` — the latter renders midnight
 * as hour 24 under some ICU builds, which would push every midnight event a
 * day forward.
 */
function wallClock(instant: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const at = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: at("year"),
    month: at("month"),
    day: at("day"),
    hour: at("hour"),
    minute: at("minute"),
    second: at("second"),
  };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** The calendar date the submitter is living in, as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  const w = wallClock(instant, safeZone(timeZone));
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** The time of day the submitter is living in, as {hour, minute}. */
export function localTime(instant: Date, timeZone: string): { hour: number; minute: number } {
  const w = wallClock(instant, safeZone(timeZone));
  return { hour: w.hour, minute: w.minute };
}

/** The zone's offset from UTC at `instant`, in ms. Positive east of Greenwich. */
function offsetMs(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Drop sub-second precision on both sides, or the difference carries the ms
  // the formatter never reported and the offset comes out a fraction short.
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

/**
 * The instant at which a wall clock of `dateStr HH:MM` reads in `timeZone`.
 *
 * Two passes, not one: the first guess uses the offset in force at the naive
 * UTC reading of that wall clock, which is the wrong offset within a few hours
 * of a DST boundary. Re-measuring at the guess converges everywhere except
 * inside the skipped hour itself, where no such instant exists and any answer
 * is a choice.
 */
export function instantFor(dateStr: string, hour: number, minute: number, timeZone: string): Date {
  const tz = safeZone(timeZone);
  const m = DATE_RE.exec(dateStr);
  if (!m) throw new RangeError(`instantFor: not a YYYY-MM-DD date: ${dateStr}`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, 0);
  const first = naive - offsetMs(new Date(naive), tz);
  return new Date(naive - offsetMs(new Date(first), tz));
}

/**
 * Replace the local calendar DATE of an instant while keeping its local time
 * of day. This is what the confirmation step's `<input type="date">` does when
 * someone corrects the day — the hour they were called at should survive it.
 */
export function withLocalDate(iso: string, dateStr: string, timeZone: string): string {
  const { hour, minute } = localTime(new Date(iso), timeZone);
  return instantFor(dateStr, hour, minute, timeZone).toISOString();
}

/* --------------------------------------------------- calendar arithmetic -- */

/* All of this runs on YYYY-MM-DD strings via UTC midnight, which is safe
   precisely BECAUSE the zone has already been applied: these are calendar
   dates, not instants, and UTC is just the arithmetic they are done in. */

function toUtcMidnight(dateStr: string): Date {
  const m = DATE_RE.exec(dateStr);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${dateStr}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function addDays(dateStr: string, days: number): string {
  const d = toUtcMidnight(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 0 = Sunday, matching WEEKDAYS below. */
export function weekdayOf(dateStr: string): number {
  return toUtcMidnight(dateStr).getUTCDay();
}

export const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;

/**
 * Resolve whatever the model put in `date` against the submitter's own today.
 *
 * A BARE WEEKDAY LOOKS BACKWARD. Logging activity is retrospective — "called
 * Mike Tuesday" said on a Wednesday means the Tuesday just gone, never the one
 * coming. "next tuesday" is the only forward form, and it is deliberately not
 * something the note of a past event should contain.
 *
 * Returns null when the token means nothing here, which the caller turns into
 * a typed failure rather than a guess.
 */
export function resolveDateToken(token: string, todayLocal: string): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  // An explicit date is taken as given, but must be a real one. Date.UTC
  // ROLLS OVER rather than failing, so "2026-13-45" would silently become a
  // day in February 2027; the round trip is what catches it.
  if (DATE_RE.test(t)) return addDays(t, 0) === t ? t : null;
  if (t === "today") return todayLocal;
  if (t === "yesterday") return addDays(todayLocal, -1);
  if (t === "tomorrow") return addDays(todayLocal, 1);

  const m = /^(?:(last|this|next)\s+)?([a-z]+)$/.exec(t);
  if (!m) return null;
  const idx = (WEEKDAYS as readonly string[]).indexOf(m[2] ?? "");
  if (idx < 0) return null;

  const qualifier = m[1] ?? "";
  const today = weekdayOf(todayLocal);
  if (qualifier === "next") {
    const ahead = (idx - today + 7) % 7;
    return addDays(todayLocal, ahead === 0 ? 7 : ahead);
  }
  let back = (today - idx + 7) % 7;
  if (qualifier === "last" && back === 0) back = 7;
  return addDays(todayLocal, -back);
}

/* -------------------------------------------------------------- parsing -- */

/** Caps, so a runaway reply cannot post a novel into the timeline. */
export const MAX_NOTE_CHARS = 2000;
export const MAX_OUTCOME_CHARS = 200;

/** The candidate row. Not written until a human has approved it. */
export interface ParsedActivity {
  kind: ActivityKind;
  outcome: string | null;
  /** ISO 8601 instant. */
  occurredAt: string;
  note: string;
}

export type ParseFailureReason = "no_json" | "no_event" | "bad_kind" | "bad_date";

export interface ParseFailure {
  reason: ParseFailureReason;
  message: string;
}

export type ParseOutcome =
  | { ok: true; parsed: ParsedActivity }
  | { ok: false; failure: ParseFailure };

/**
 * The instruction handed to the model. Built here rather than in the verb so a
 * test can assert the raw text and the zone actually reach it.
 *
 * The reply contract is deliberately small and closed: a fixed kind enum, a
 * date token this file knows how to resolve, and a note. Anything richer would
 * be another thing to validate for no gain — the human confirms the row anyway.
 */
export function buildParsePrompt(input: {
  text: string;
  timeZone: string;
  todayLocal: string;
}): string {
  return [
    "Read one salesperson's note about a contact event and return JSON describing it.",
    "",
    "Reply with ONE JSON object and nothing else. Fields:",
    `  kind      one of: ${HUMAN_KINDS.join(", ")}`,
    "  outcome   a few words on how it went, or null",
    "  note      the event, cleaned up into one sentence, keeping every concrete",
    "            detail (names, amounts, what they asked for, deadlines)",
    "  date      when the event happened: YYYY-MM-DD, or one of today, yesterday,",
    "            a weekday name, or 'last <weekday>'. Use null if it is not said.",
    "  time      HH:MM in 24h local time if the note says a time, else null",
    "  event     false if the text describes no contact event at all",
    "",
    "Only the event that already HAPPENED sets `date`. A future commitment in",
    "the text ('wants a quote by Friday') belongs in the note, never in `date`.",
    "",
    `The writer's timezone is ${input.timeZone} and their local date is ${input.todayLocal}.`,
    "",
    "NOTE:",
    input.text,
  ].join("\n");
}

/** Pull the first JSON object out of a reply that may be fenced or chatty. */
function extractJson(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * LAYER B. The model's reply plus the submitter's clock in, a candidate row
 * or a typed failure out. Pure — same inputs, same output, forever.
 *
 * `rawText` is the fallback note: a model that classified the event but
 * returned an empty note must not produce a blank timeline entry, and the
 * words the person actually typed are the honest thing to keep.
 */
export function resolveActivity(
  reply: string,
  opts: { now: Date; timeZone: string; rawText: string },
): ParseOutcome {
  const tz = safeZone(opts.timeZone);
  const todayLocal = localDate(opts.now, tz);

  const body = extractJson(typeof reply === "string" ? reply : "");
  if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      failure: { reason: "no_json", message: "the parser did not return a JSON object" },
    };
  }
  const r = body as Record<string, unknown>;

  if (r.event === false) {
    return {
      ok: false,
      failure: { reason: "no_event", message: "no contact event was described in that text" },
    };
  }

  const kind = str(r.kind).toLowerCase();
  if (!kind) {
    return {
      ok: false,
      failure: { reason: "no_event", message: "no contact event was described in that text" },
    };
  }
  if (!(HUMAN_KINDS as readonly string[]).includes(kind)) {
    // Includes the three agent kinds on purpose: 0009 reserves them for
    // service_role, so a model naming one is a parse failure, not a write.
    return { ok: false, failure: { reason: "bad_kind", message: `not a kind a person logs: ${kind}` } };
  }

  const token = str(r.date);
  const dateLocal = token === "" || token === "null" ? todayLocal : resolveDateToken(token, todayLocal);
  if (dateLocal === null) {
    return { ok: false, failure: { reason: "bad_date", message: `could not read a date from "${token}"` } };
  }

  // Time of day, in order of preference: what the note said, then the actual
  // submit time when the event is today, then local noon. Noon rather than
  // midnight because midnight sits on the boundary this whole file exists to
  // get right — an off-by-one-hour anywhere would move the calendar day.
  const timeMatch = TIME_RE.exec(str(r.time));
  let occurredAt: string;
  if (timeMatch) {
    occurredAt = instantFor(
      dateLocal,
      Math.min(23, Number(timeMatch[1])),
      Math.min(59, Number(timeMatch[2])),
      tz,
    ).toISOString();
  } else if (dateLocal === todayLocal) {
    occurredAt = opts.now.toISOString();
  } else {
    occurredAt = instantFor(dateLocal, 12, 0, tz).toISOString();
  }

  const note = (str(r.note) || opts.rawText.trim()).slice(0, MAX_NOTE_CHARS);
  const outcome = str(r.outcome).slice(0, MAX_OUTCOME_CHARS) || null;

  return { ok: true, parsed: { kind: kind as ActivityKind, outcome, occurredAt, note } };
}
