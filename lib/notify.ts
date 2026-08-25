/**
 * notify.ts — the decision layer between "something happened" and "who hears
 * about it, and how".
 *
 * THE INBOX IS UNCONDITIONAL. Every event routes to `inbox_items`, through
 * `inbox_post` and nothing else — there is exactly one insert path into an
 * inbox in this codebase and this file does not become a second one.
 *
 * EMAIL IS THE EXCEPTION AND THE RULE IS SETTLED. Four events send one:
 *
 *   job_run_failed      → the admin (a scheduled run that died)
 *   job_run_attention   → the admin (a run that came back with findings)
 *   task_assigned       → the assignee, whoever they are
 *   lead_reply_meeting  → the admin (a lead asking for a meeting)
 *
 * and three deliberately do not: `job_run_ok`, `daily_briefing`,
 * `agent_proposal`. That list is `EMAIL_EVENTS` below and it is the whole
 * policy — do not re-derive it at a call site, and do not add an `if` next to
 * one. `job_run_attention` was added by item 12 exactly that way: a line in
 * the table, not a branch. It does not widen the settled rule — a run that did
 * not come back clean already emailed the admin, and item 9 was folding these
 * into `job_run_failed` to get that. It only stops the row from lying about
 * which of the two happened.
 *
 * NOTE THAT THE TWO RECIPIENTS ARE NOT THE SAME PERSON. A member's skill run
 * that fails puts the notice in THEIR inbox (they are the one waiting on it)
 * and the email on the ADMIN's desk (they are the one who fixes it). Splitting
 * the two is the reason `routeEvent` returns both rather than one address.
 *
 * NOTHING HERE SENDS. lib/mailer.ts is the one adapter and its only
 * implementation today is a no-op, because the send half of this item is
 * blocked on an interactive Resend signup — docs/NOTIFICATIONS.md. So the
 * degraded path is the ONLY path right now, and it is the one that must not
 * lose anything: the inbox item is written, the payload is rendered, the
 * payload is recorded in `email_outbox` as pending (0012), and a line is
 * logged. Nothing in this file throws at its caller.
 *
 * MONEY. An email to a non-admin carries no money figure, which is the same
 * rule `defineVerb` applies to a verb's result — and it is applied with the
 * same helper, `stripMoney`, run over the event's structured `facts` BEFORE
 * they are rendered into text. Stripping the rendered string instead would be
 * a second money-stripper written against a different shape, which is how one
 * gets missed.
 *
 * Everything is INJECTED — the clients, the mailer, the clock, the admin
 * lookup — so a test drives the real decision path and nothing reaches a
 * network, a key, or a real address.
 */

import { getConfig } from "./env";
import { getProfile, listProfiles } from "./profiles";
import { inbox_post, type InboxPostInput } from "./agent/verbs/inbox_post";
import { stripMoney, type Caller, type CallerRole, type DbClient } from "./agent/verbs/types";
import { getMailer, type EmailPayload, type Mailer } from "./mailer";

/* ------------------------------------------------------------------ rules -- */

export type NotifyEventKind =
  | "job_run_failed"
  // The seventh kind, added by item 12. Item 9 folded "the sweep found a site
  // down" into `job_run_failed` because a seventh kind was the thing it did
  // not want to add; the cost was that a healthy run reads as a broken one
  // wherever the status is shown. Same audience, different sentence.
  | "job_run_attention"
  | "job_run_ok"
  | "task_assigned"
  | "lead_reply_meeting"
  | "daily_briefing"
  | "agent_proposal";

/** Who the EMAIL goes to. Absence from this table means: no email, ever. */
const EMAIL_AUDIENCE: Partial<Record<NotifyEventKind, "admin" | "subject">> = {
  job_run_failed: "admin",
  // Same audience as a failure on purpose: a client's site being down is the
  // admin's problem whether or not the job that noticed it was healthy.
  job_run_attention: "admin",
  lead_reply_meeting: "admin",
  // "all employees get this one" — the assignee, not the admin.
  task_assigned: "subject",
};

/** The ones that send. Derived from the table above so the two cannot drift. */
export const EMAIL_EVENTS: readonly NotifyEventKind[] = Object.keys(
  EMAIL_AUDIENCE,
) as NotifyEventKind[];

/** The three that deliberately do not. Named, so a test can assert on them. */
export const INBOX_ONLY_EVENTS: readonly NotifyEventKind[] = [
  "job_run_ok",
  "daily_briefing",
  "agent_proposal",
];

export const emailsFor = (kind: NotifyEventKind): boolean => kind in EMAIL_AUDIENCE;

/* ------------------------------------------------------------- recipients -- */

/**
 * Somebody an email can be addressed to. `profileId` is null for an address
 * with no `profiles` row behind it — which today only happens when the admin
 * lookup finds nothing and falls back to the configured address.
 */
export interface Recipient {
  profileId: string | null;
  email: string;
  displayName: string;
  /**
   * WHAT THE MONEY RULE READS, and it fails closed. `profiles` has no role
   * column on purpose (role lives in the JWT — see lib/profiles.ts), so the
   * only person this layer can positively identify as an admin is the one the
   * configured admin address resolves to. Everyone else is `member` and gets
   * no money figures, which is the safe direction to be wrong in.
   */
  role: CallerRole;
}

/** The admin's address, from config. Never a literal in business logic. */
export const adminEmail = (): string => getConfig().notifyAdminEmail;

const isAdminAddress = (email: string): boolean =>
  email.trim().toLowerCase() === adminEmail().trim().toLowerCase();

/** The role an address gets. See the note on `Recipient.role`. */
export const roleForEmail = (email: string): CallerRole =>
  isAdminAddress(email) ? "admin" : "member";

/**
 * Resolve "Nate" the way the item asks: by looking him up, not by writing his
 * address into a decision. The configured admin address selects a `profiles`
 * row, and everything downstream — the display name, the profile id on the
 * outbox row — comes from that row.
 *
 * A missing profile still yields a recipient rather than null: an unresolvable
 * directory must not swallow the one email that says the automation is broken.
 */
export async function resolveAdmin(db?: DbClient | null): Promise<Recipient> {
  const email = adminEmail();
  const fallback: Recipient = { profileId: null, email, displayName: "Nate", role: "admin" };
  if (!db) return fallback;
  try {
    const wanted = email.trim().toLowerCase();
    const match = (await listProfiles(db)).find((p) => p.email.trim().toLowerCase() === wanted);
    if (!match) return fallback;
    return {
      profileId: match.id,
      email: match.email,
      displayName: match.display_name,
      role: "admin",
    };
  } catch (err) {
    console.warn("[notify] could not resolve the admin profile:", err);
    return fallback;
  }
}

/** One employee, by profile id. Null when the directory cannot answer. */
export async function resolveProfile(
  db: DbClient | null | undefined,
  profileId: string,
): Promise<Recipient | null> {
  if (!db) return null;
  try {
    const p = await getProfile(db, profileId);
    if (!p) return null;
    return {
      profileId: p.id,
      email: p.email,
      displayName: p.display_name,
      role: roleForEmail(p.email),
    };
  } catch (err) {
    console.warn("[notify] could not resolve a recipient profile:", err);
    return null;
  }
}

/* ------------------------------------------------------------------ event -- */

export interface NotifyEvent {
  kind: NotifyEventKind;
  /** Whose INBOX. Always written, for every kind. */
  inboxProfileId: string;
  title: string;
  body: string;
  sourceJob?: string | null;
  accountId?: string | null;
  clientId?: string | null;
  /**
   * Structured extras appended to the email under their own headings. Money
   * columns here are removed for a non-admin recipient by `stripMoney`, before
   * any of it becomes text.
   */
  facts?: Record<string, unknown>;
}

export interface Routed {
  inbox: InboxPostInput;
  /** Null for the three inbox-only kinds, or when no address could be found. */
  email: (EmailPayload & { recipient: Recipient }) | null;
}

/** Render the `facts` a recipient is allowed to see, as `key: value` lines. */
function renderFacts(facts: Record<string, unknown> | undefined, role: CallerRole): string {
  if (!facts) return "";
  const visible = stripMoney(facts, role);
  const lines = Object.entries(visible)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${String(v)}`);
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}

/**
 * The decision, as a pure function: one event in, an inbox item and at most one
 * email payload out. No client, no clock, no env — which is why every routing
 * rule is a unit test and not a database fixture.
 *
 * `admin` and `subject` are passed IN rather than looked up here, so the rule
 * table above is the only thing this function knows.
 */
export function routeEvent(
  event: NotifyEvent,
  who: { admin: Recipient | null; subject: Recipient | null },
): Routed {
  const inbox: InboxPostInput = {
    profileId: event.inboxProfileId,
    kind: event.kind,
    title: event.title,
    body: event.body,
    sourceJob: event.sourceJob ?? null,
    accountId: event.accountId ?? null,
    clientId: event.clientId ?? null,
  };

  const audience = EMAIL_AUDIENCE[event.kind];
  if (!audience) return { inbox, email: null };

  const recipient = audience === "admin" ? who.admin : who.subject;
  if (!recipient) return { inbox, email: null };

  return {
    inbox,
    email: {
      recipient,
      to: recipient.email,
      subject: `[bcns] ${event.title}`,
      body:
        `${recipient.displayName},\n\n${event.body}` +
        renderFacts(event.facts, recipient.role) +
        `\n\nThis notice is also in your inbox at /inbox.\n— the bcns command center`,
    },
  };
}

/* --------------------------------------------------------------- delivery -- */

export interface NotifyDeps {
  /** Service-role client. `inbox_items` has no INSERT policy; see inbox_post. */
  serviceDb?: DbClient;
  /** Who or what caused the event. Not necessarily who hears about it. */
  caller: Caller;
  /** Defaults to `getMailer()`, which today is always the no-op. */
  mailer?: Mailer;
  /** Overridable so a test never touches the directory. */
  admin?: () => Promise<Recipient>;
  now?: () => Date;
}

export interface NotifyOutcome {
  /** The inbox row's id, or null if it could not be written. */
  inboxItemId: string | null;
  /** The rendered payload, whether or not anything accepted it. */
  email: EmailPayload | null;
  /** True only when an adapter actually took it. False for every path today. */
  delivered: boolean;
  /** The `email_outbox` row's id — the durable record. Null if that failed too. */
  outboxId: string | null;
}

/**
 * May this address be handed to an adapter at all?
 *
 * The guardrail is "never send to any address other than a configured test
 * address", and the honest way to hold it is a check in front of `send` rather
 * than a promise in a comment. An address off the list is still rendered and
 * still recorded — it is simply never transmitted, which is exactly what the
 * pending row means.
 */
export function maySend(to: string, allowed = getConfig().notifyAllowedRecipients): boolean {
  return allowed.includes(to.trim().toLowerCase());
}

/** Write the durable record. Best effort, like everything else here. */
async function recordEmail(
  db: DbClient | undefined,
  event: NotifyEvent,
  email: EmailPayload & { recipient: Recipient },
  outcome: { status: "pending" | "sent" | "failed"; error: string | null; at: Date },
): Promise<string | null> {
  if (!db) {
    console.warn("[notify] no service client: the email for", event.kind, "was NOT recorded");
    return null;
  }
  try {
    const { data, error } = await db
      .from("email_outbox")
      .insert({
        kind: event.kind,
        to_email: email.to,
        subject: email.subject,
        body: email.body,
        to_profile_id: email.recipient.profileId,
        source_job: event.sourceJob ?? null,
        status: outcome.status,
        error: outcome.error,
        attempts: 1,
        sent_at: outcome.status === "sent" ? outcome.at.toISOString() : null,
      })
      .select("id")
      .single();
    if (error) {
      console.warn("[notify] could not record the email:", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.warn("[notify] could not record the email:", err);
    return null;
  }
}

/**
 * Route one event and act on the answer.
 *
 * ORDER MATTERS: the inbox first, because it is the half that always happens
 * and the half a person actually reads. The email half runs afterwards and
 * independently — a failed inbox write does not cancel the email, and a failed
 * email does not undo the inbox item. Neither can throw, because by the time
 * this runs the thing being reported has already happened.
 */
export async function deliverNotification(
  deps: NotifyDeps,
  event: NotifyEvent,
  subject: Recipient | null = null,
): Promise<NotifyOutcome> {
  const out: NotifyOutcome = { inboxItemId: null, email: null, delivered: false, outboxId: null };
  const now = deps.now?.() ?? new Date();

  const admin = emailsFor(event.kind)
    ? await (deps.admin?.() ?? resolveAdmin(deps.serviceDb))
    : null;
  const routed = routeEvent(event, { admin, subject });

  // -- always: the inbox --------------------------------------------------
  if (deps.serviceDb) {
    try {
      // Posted UNDER THE RECIPIENT, through the service client, exactly as
      // lib/agent/task-nudge.ts does and for the same reason: inbox_post's own
      // rule is "a member may post only to their own inbox", and the person an
      // event is about is usually not the person who caused it. The identity
      // below is the same expression as the destination, so no argument
      // reaches a third person's inbox.
      const res = await inbox_post.run(
        { caller: { ...deps.caller, profileId: routed.inbox.profileId }, db: deps.serviceDb },
        routed.inbox,
      );
      if (res.ok) out.inboxItemId = res.data.id;
      else console.warn("[notify] inbox post refused:", res.error.code, res.error.message);
    } catch (err) {
      console.warn("[notify] inbox post threw:", err);
    }
  } else {
    console.warn("[notify] no service client: no inbox item for", event.kind);
  }

  // -- sometimes: the email -----------------------------------------------
  if (!routed.email) return out;
  out.email = { to: routed.email.to, subject: routed.email.subject, body: routed.email.body };

  const mailer = deps.mailer ?? getMailer();
  let status: "pending" | "sent" | "failed" = "pending";
  let error: string | null = null;

  if (!maySend(routed.email.to)) {
    error = `recipient is not on NOTIFY_ALLOWED_RECIPIENTS; rendered but not sent`;
  } else {
    try {
      const sent = await mailer.send(out.email);
      if (sent.ok) {
        status = "sent";
        out.delivered = true;
      } else {
        // A provider that said no has FAILED. No provider at all leaves the
        // row PENDING — the payload is still owed and a later retry owes it.
        status = sent.configured ? "failed" : "pending";
        error = sent.error;
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  if (!out.delivered) {
    console.warn(`[notify] ${event.kind} email undelivered (${status}) to ${out.email.to}: ${error}`);
  }
  out.outboxId = await recordEmail(deps.serviceDb, event, routed.email, { status, error, at: now });
  return out;
}

/* --------------------------------------------------------------- job runs -- */

/** The shape item 9's jobs close a run with. Only these four fields are read. */
export interface JobRunRow {
  job: string;
  status: string;
  actor?: string | null;
  log?: string | null;
}

/**
 * Route a finished `job_runs` row. This is what the scheduled jobs (item 9)
 * call when they close a run, and it is the whole of "a failed run emails
 * Nate, a successful one does not".
 *
 * `running` and `cancelled` return null and notify nobody: neither is an
 * outcome. A cancelled run was stopped by the person who started it, and they
 * do not need to be told what they just did.
 *
 * `inboxProfileId` defaults to the ADMIN's profile, because a scheduled run has
 * no person behind it — `job_runs.actor` is a cron name, not a profile. A job
 * acting for somebody passes theirs.
 */
export async function notifyJobRun(
  deps: NotifyDeps,
  row: JobRunRow,
  inboxProfileId?: string,
): Promise<NotifyOutcome | null> {
  // THREE OUTCOMES, NOT TWO. `attention` is a run that came back and found
  // something; `failed` is a run that did not come back. Both reach the admin,
  // and the difference is the sentence, not the audience — see the kind table.
  const failed = row.status === "error" || row.status === "failed";
  const attention = row.status === "attention";
  const succeeded = row.status === "ok";
  if (!failed && !attention && !succeeded) return null;

  const admin = await (deps.admin?.() ?? resolveAdmin(deps.serviceDb));
  const profileId = inboxProfileId ?? admin.profileId;
  if (!profileId) {
    console.warn("[notify] no inbox to post a", row.status, "run for", row.job, "to");
  }

  return deliverNotification(
    // The admin is resolved once and handed on, so the directory is read once
    // per run rather than once per half.
    { ...deps, admin: async () => admin },
    {
      kind: failed ? "job_run_failed" : attention ? "job_run_attention" : "job_run_ok",
      inboxProfileId: profileId ?? "",
      title: failed
        ? `${row.job} failed`
        : attention
          ? `${row.job} needs attention`
          : `${row.job} finished`,
      body:
        row.log ??
        (failed
          ? `${row.job} did not finish.`
          : attention
            ? `${row.job} ran and found something to look at.`
            : `${row.job} finished cleanly.`),
      sourceJob: row.job,
      facts: { job: row.job, status: row.status, actor: row.actor ?? null },
    },
  );
}
