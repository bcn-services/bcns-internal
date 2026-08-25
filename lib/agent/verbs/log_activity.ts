/**
 * log_activity — write one row into an account's timeline, or propose one.
 *
 * TWO PATHS, AND ONLY ONE OF THEM WRITES.
 *
 *   Explicit path — the caller names `kind`. Writes exactly one row. This is
 *                   what the confirmation step submits, with whatever the
 *                   human edited, and it is the ONLY path that touches the
 *                   database.
 *   Parse path    — the caller passes free `text` and no `kind`. This is
 *                   LAYER A: it builds the prompt, hands it to the injected
 *                   runner, and passes the reply to the pure resolver in
 *                   ../activity-parse.ts. It returns `{ written: false,
 *                   proposal }` and WRITES NOTHING. A parsed row a person has
 *                   not seen has no business in an audit trail.
 *
 * The runner is INJECTED (`ctx.runParse`), never imported here. That keeps the
 * verb layer free of `node:child_process` — and it is what lets the four
 * guarantees below be tested without a model call.
 *
 * AGENT KINDS ARE REFUSED HERE. 0009 narrowed `account_activity_staff_insert`
 * so an interactive member cannot insert `ai_email_sent` / `ai_email_reply` /
 * `agent_run`; only service_role writes those. This verb refuses them for
 * EVERY caller, admin included, because an admin's own 0002 policy
 * (`account_activity_admin_all`, FOR ALL) would otherwise let the audit trail
 * be forged through the very surface a model can reach. The resolver refuses
 * them too, so a model naming one is a parse failure rather than a proposal.
 *
 * `actor_email` is always the caller's, never taken from input or from the
 * text — forging authorship is the whole risk in a free-text logging verb.
 */

import { logActivity as writeActivity, isUuid } from "../../accounts";
import {
  buildParsePrompt,
  localDate,
  resolveActivity,
  safeZone,
  type ParsedActivity,
} from "../activity-parse";
import { AGENT_KINDS, HUMAN_KINDS, type ActivityKind } from "./activity_query";
import { defineVerb, fail, ok, type DbClient, type VerbResult } from "./types";

export interface LogActivityInput {
  /** The account. Give this or `clientId`. */
  accountId?: string;
  /** A client uuid; its `account_id` is looked up. */
  clientId?: string;
  text?: string;
  kind?: ActivityKind;
  note?: string | null;
  outcome?: string | null;
  /** ISO instant. Defaults to now. */
  occurredAt?: string | null;
  /** IANA zone of the person typing. Relative dates resolve against it. */
  timeZone?: string;
}

export interface LogActivityWritten {
  written: true;
  accountId: string;
  kind: ActivityKind;
  note: string | null;
  outcome: string | null;
  occurredAt: string;
  actorEmail: string;
}

export interface LogActivityProposed {
  written: false;
  accountId: string;
  actorEmail: string;
  proposal: ParsedActivity;
}

export type LogActivityResult = LogActivityWritten | LogActivityProposed;

/** Resolve `clientId` to the account it belongs to. */
async function accountForClient(db: DbClient, clientId: string): Promise<string | null> {
  const res = await db.from("clients").select("account_id").eq("id", clientId).maybeSingle();
  if (res.error) throw new Error(`log_activity: ${res.error.message}`);
  const row = res.data as { account_id?: unknown } | null;
  return typeof row?.account_id === "string" ? row.account_id : null;
}

export const log_activity = defineVerb<LogActivityInput, LogActivityResult>({
  name: "log_activity",
  description:
    "Record one contact event on an account. REQUIRED: exactly one of `accountId` or " +
    "`clientId` to say which account, AND one of `kind` or `text` — an explicit `kind` " +
    "writes the row, while `text` alone is parsed into a proposed row that is returned " +
    "for confirmation and is NOT written until it comes back with a kind. (JSON Schema " +
    "cannot express either/or in `required`, so the rule is stated here and enforced " +
    "in the handler.)",
  roles: ["admin", "member"],
  properties: {
    accountId: { type: "string", description: "Account uuid the event happened on." },
    clientId: { type: "string", description: "Client uuid, if the account is not known." },
    text: { type: "string", description: "Free-text description of what happened." },
    kind: { type: "string", description: "The event kind. Omit to parse `text` instead.", enum: HUMAN_KINDS },
    note: { type: "string", description: "Cleaned note to store. Defaults to `text`." },
    outcome: { type: "string", description: "A few words on how it went." },
    occurredAt: { type: "string", description: "When it happened, as an ISO instant." },
    timeZone: { type: "string", description: "IANA zone of the person writing, e.g. America/New_York." },
  },
  required: [],
  async handler(ctx, input): Promise<VerbResult<LogActivityResult>> {
    if (!ctx.db) return fail("not_configured", "log_activity: no database client was injected");

    /* -------------------------------------------------- which account -- */
    let accountId: string;
    if (input.accountId !== undefined && input.accountId !== null) {
      if (!isUuid(input.accountId)) return fail("invalid_input", `bad account id: ${input.accountId}`);
      accountId = input.accountId;
    } else if (input.clientId !== undefined && input.clientId !== null) {
      if (!isUuid(input.clientId)) return fail("invalid_input", `bad client id: ${input.clientId}`);
      const found = await accountForClient(ctx.db, input.clientId);
      if (!found) return fail("not_found", `no client with id ${input.clientId}`);
      accountId = found;
    } else {
      return fail("invalid_input", "log_activity needs an accountId or a clientId");
    }

    /* ------------------------------------------------------- the kind -- */
    if (input.kind !== undefined && AGENT_KINDS.includes(input.kind)) {
      return fail(
        "forbidden",
        `${input.kind} is written by the automation as service_role, not through log_activity`,
      );
    }
    if (input.kind !== undefined && !HUMAN_KINDS.includes(input.kind)) {
      return fail("invalid_input", `unknown activity kind: ${String(input.kind)}`);
    }

    const timeZone = safeZone(input.timeZone);
    const now = ctx.now ? ctx.now() : new Date();

    /* ----------------------------------------------- LAYER A: parsing -- */
    if (input.kind === undefined) {
      if (typeof input.text !== "string" || input.text.trim() === "") {
        return fail("invalid_input", "log_activity needs either a kind or some text");
      }
      if (!ctx.runParse) {
        return fail("not_configured", "log_activity: no parser was injected");
      }

      // The RAW text goes to the model, and the submitter's own zone and local
      // date go with it. Both are asserted in the tests — a prompt that lost
      // either would still "work" while quietly resolving dates off the server.
      const prompt = buildParsePrompt({
        text: input.text,
        timeZone,
        todayLocal: localDate(now, timeZone),
      });

      const run = await ctx.runParse(prompt);
      if (!run.ok) {
        // A queue that is full and a clock that ran out are not parse failures:
        // nothing was wrong with the text, and the honest answer is "try again".
        if (run.busy) return fail("busy", run.error);
        if (run.timedOut) return fail("timeout", run.error);
        return fail("parse_failure", `could not read that text: ${run.error}`);
      }

      // LAYER B. Pure from here down.
      const outcome = resolveActivity(run.reply, { now, timeZone, rawText: input.text });
      if (!outcome.ok) return fail("parse_failure", outcome.failure.message);

      // Deliberately no write. The caller confirms, then submits with a kind.
      return ok({
        written: false,
        accountId,
        actorEmail: ctx.caller.email,
        proposal: outcome.parsed,
      });
    }

    /* ------------------------------------------------ the single write -- */
    let occurredAt = now.toISOString();
    if (input.occurredAt !== undefined && input.occurredAt !== null && input.occurredAt !== "") {
      const when = new Date(input.occurredAt);
      if (Number.isNaN(when.getTime())) {
        return fail("invalid_input", `not a date: ${input.occurredAt}`);
      }
      occurredAt = when.toISOString();
    }

    const note = (input.note ?? input.text ?? null) || null;
    const outcome = (typeof input.outcome === "string" ? input.outcome.trim() : "") || null;

    // One insert path for the whole app: lib/accounts.ts owns the column names
    // and the id check, and a second `.insert()` here is how the two drift.
    await writeActivity(ctx.db, {
      accountId,
      kind: input.kind,
      note,
      outcome,
      occurredAt,
      // Never from input, never from the text: authorship is the session's.
      actor: ctx.caller.email,
    });

    return ok({
      written: true,
      accountId,
      kind: input.kind,
      note,
      outcome,
      occurredAt,
      actorEmail: ctx.caller.email,
    });
  },
});
