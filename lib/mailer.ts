/**
 * mailer.ts — the ONE adapter behind which sending lives, and its no-op.
 *
 * Two implementations: `nullMailer` (no provider configured) and `smtpMailer`
 * (the bot mailbox on Google Workspace). `getMailer` picks between them from
 * the environment. Sending stays off until the four SMTP_* vars and MAIL_FROM
 * are all set — see docs/NOTIFICATIONS.md.
 *
 * The interface is the seam that let the routing layer be finished and tested
 * while no transport existed, and it is what a second transport plugs into if
 * cold outreach ever needs its own.
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
 * SMTP, for the bot mailbox on Google Workspace.
 *
 * WHY SMTP AND NOT RESEND: every notice this system sends goes to a bcns
 * employee — a failed job, an assigned task, a lead asking for a meeting. None
 * goes to a lead. A Workspace mailbox carries that volume without a third-party
 * provider. Resend's separate subdomain and DKIM are for cold outreach, which
 * nothing here sends; keeping the transports apart is the point of that split.
 *
 * The transporter is built per call rather than cached at module scope. Sends
 * are rare and a cached transporter would pin one credential for the process's
 * life, so a rotated app password would not take effect until a restart.
 */
export function smtpMailer(opts: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}): Mailer {
  return {
    name: "smtp",
    async send(payload: EmailPayload): Promise<SendResult> {
      try {
        // Imported here, not at module top level, so the module stays loadable
        // (and every test that never sends stays fast) without nodemailer.
        const nodemailer = await import("nodemailer");
        const transport = nodemailer.createTransport({
          host: opts.host,
          port: opts.port,
          // 465 is implicit TLS. Any other port starts plaintext and upgrades
          // via STARTTLS, which nodemailer requires by default.
          secure: opts.port === 465,
          auth: { user: opts.user, pass: opts.pass },
        });
        const info = await transport.sendMail({
          from: opts.from,
          to: payload.to,
          subject: payload.subject,
          text: payload.body,
        });
        return { ok: true, id: info.messageId };
      } catch (err) {
        // `configured: true` — a provider exists and refused. That records the
        // row as `failed`, not `pending`, because a retry against the same
        // broken configuration will fail the same way.
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          configured: true,
        };
      }
    },
  };
}

/**
 * Whichever adapter the environment has.
 *
 * SMTP wins if it is completely configured. A partial configuration is treated
 * as no configuration: a missing password must park the email as `pending`, not
 * hand nodemailer an empty credential and record a `failed` row that looks like
 * the provider rejected it.
 *
 * `deliverNotification` calls this and nothing else, so one adapter is the
 * whole send surface. Do not add a second entry point.
 */
export function getMailer(): Mailer {
  const { smtpHost, smtpPort, smtpUser, smtpPass, mailFrom } = getConfig();
  if (smtpHost && smtpPort && smtpUser && smtpPass && mailFrom) {
    return smtpMailer({
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
      pass: smtpPass,
      from: mailFrom,
    });
  }
  return nullMailer;
}
