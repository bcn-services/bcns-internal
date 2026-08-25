/**
 * mailer.ts — the ONE adapter behind which sending lives, and its no-op.
 *
 * THE SEND HALF OF ITEM 7 IS BLOCKED. Configuring Resend needs an interactive
 * signup, which the run that built this was not permitted to do, so no provider
 * exists: no dependency, no key, nothing in any env file. See
 * docs/NOTIFICATIONS.md for the numbered steps a human follows to unblock it —
 * the only file that has to change is this one, and only the marked place.
 *
 * WHY AN INTERFACE WITH ONE IMPLEMENTATION, which is normally a smell: the one
 * implementation is a NULL one. The interface is not speculative flexibility,
 * it is the seam that lets the routing layer be finished and tested while the
 * transport does not exist, and it is what the blocked half plugs into.
 *
 * Nothing here reads a key at import time — lib/env.ts's rule — so the app
 * builds and every test runs with no mail configuration at all.
 */

import { getConfig } from "./env";

/** A rendered email. Exactly what an adapter is handed and what is recorded. */
export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

export type SendResult =
  | { ok: true; id?: string }
  /** `configured: false` separates "nowhere to send" from "the provider said no". */
  | { ok: false; error: string; configured: boolean };

export interface Mailer {
  /** For the log line and the report; never for a decision. */
  readonly name: string;
  send(payload: EmailPayload): Promise<SendResult>;
}

/**
 * The no-op. It does not throw and it does not pretend: every call is a refusal
 * carrying `configured: false`, which is what makes the caller record the
 * payload as `pending` rather than `failed`. A pending row is retryable; a
 * failed one is a provider's verdict.
 */
export const nullMailer: Mailer = {
  name: "none",
  async send(): Promise<SendResult> {
    return { ok: false, error: "no mail provider is configured", configured: false };
  },
};

/**
 * Whichever adapter the environment has. Today that is always `nullMailer`.
 *
 * WHEN RESEND IS CONFIGURED this is the only function that changes: read
 * `config.resendApiKey`, and when it is present return an adapter whose `send`
 * POSTs to https://api.resend.com/emails with `from: config.mailFrom`. Do not
 * add a second entry point — `deliverNotification` calls this and nothing else,
 * so one adapter is the whole send surface.
 */
export function getMailer(): Mailer {
  const { resendApiKey } = getConfig();
  if (!resendApiKey) return nullMailer;
  // Deliberately still the no-op: the adapter is not written, and a key alone
  // must not turn into a silent real send from a half-finished item. Replacing
  // this line is step 5 of docs/NOTIFICATIONS.md.
  return nullMailer;
}
