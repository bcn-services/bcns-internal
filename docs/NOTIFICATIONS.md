# Notifications — routing and sending

The routing layer is built and tested. **Sending is built and needs one setup
step**: a bot mailbox on Google Workspace, and its credentials in the env file.

Until those are set, every email this system decides to send is **rendered in
full and recorded in the `email_outbox` table with status `pending`** — nothing
is lost, and finishing the setup is a configuration job, not a rewrite.

## Why a mailbox and not Resend

Every notice this system sends goes to a **bcns employee**: a failed scheduled
run, a task assigned, a lead asking for a meeting. None goes to a lead. A
Workspace mailbox carries that volume — a handful of messages a day against a
2,000-recipient daily limit — with no third-party provider and no new account.

Resend still has a job, and it is a different one. **Cold outreach to leads must
never go through the bot mailbox.** Google's terms prohibit unsolicited bulk
mail, and a complaint spiral against `bcn-services.com` would take down the
mailbox that carries these internal notices along with it. When outreach sending
is built, it gets its own subdomain and its own DKIM, exactly so the two
reputations cannot touch. `lib/mailer.ts` already has the seam for a second
transport.

## What is already built

| Piece | File |
|---|---|
| The routing rule and the rendered payload | `lib/notify.ts` |
| The send adapter interface, and its no-op | `lib/mailer.ts` |
| The durable record of an undelivered email | `supabase/migrations/0012_email_outbox.sql` |
| Tests | `tests/notification-routing.test.mjs`, `tests/email-outbox-migration.test.mjs` |

### The rule (settled — do not re-derive it)

Three events send an email:

- `job_run_failed` — a scheduled run that failed → **the admin**
- `task_assigned` — a task assigned → **that assignee**, whoever they are
- `lead_reply_meeting` — a lead replying that they want a meeting → **the admin**

Three deliberately do not: `job_run_ok`, `daily_briefing`, `agent_proposal`.

**Everything goes to the inbox regardless**, through `inbox_post` — there is one
insert path into `inbox_items` and the routing layer does not become a second.

The rule lives in one table, `EMAIL_AUDIENCE` in `lib/notify.ts`. A seventh
event kind is a line in that table, never an `if` at a call site.

### The adapter interface

`lib/mailer.ts`:

```ts
export interface EmailPayload { to: string; subject: string; body: string; }

export type SendResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; configured: boolean };

export interface Mailer {
  readonly name: string;
  send(payload: EmailPayload): Promise<SendResult>;
}
```

`configured: false` means *there was nowhere to send*, and the payload is
recorded `pending` — still owed, and a later retry owes it. `configured: true`
means *a provider refused it*, and the payload is recorded `failed` with the
provider's reason. That distinction is the only thing the routing layer asks of
an adapter.

---

## Setting up the bot mailbox — what a human must do

An unattended agent cannot do steps 1–4: they need an interactive Google Admin
sign-in, and step 3 produces a credential no agent may handle.

1. **Create the mailbox.** Google Admin (admin.google.com, signed in as an
   admin of `bcn-services.com`) → *Directory* → *Users* → *Add new user*.
   Name it something a recipient will understand — `bcns bot`, address
   `bot@bcn-services.com`. A full user seat is billable; a **group** with the
   same address is free but cannot authenticate to SMTP, so it has to be a user.

2. **Turn on 2-Step Verification** for that account. Sign in as the bot once at
   myaccount.google.com and enable it. Google will not issue an app password
   without it.

3. **Create an app password.** myaccount.google.com → *Security* → *App
   passwords* → name it `bcns-internal`. Google shows a 16-character string
   **once**. This is a credential: do not paste it into a chat, a commit, or an
   issue. It is scoped to this one app and can be revoked on its own without
   touching the account password.

4. **Put it in `.env.local`** (gitignored; never `.env.example`):

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=bot@bcn-services.com
   SMTP_PASS=<the 16-character app password, no spaces>
   MAIL_FROM=bcns <bot@bcn-services.com>
   ```

   All five must be present. A partial configuration is deliberately treated as
   no configuration, so a missing password parks mail as `pending` rather than
   recording it as permanently `failed`.

5. **Send one test message.** `NOTIFY_ALLOWED_RECIPIENTS` defaults to
   `nseluga@g.hmc.edu`, so that is the only address a send can reach until you
   widen it. Trigger a `task_assigned` notice to yourself and confirm it lands.
   This is the step the test suite cannot do — `tests/mailer-smtp.test.mjs`
   proves the transport selection and the failure path, never a real delivery.

6. **Check where it landed.** First message from a new sender often goes to
   spam. If it does, the SPF record for `bcn-services.com` must include Google:
   `v=spf1 include:_spf.google.com ~all`. DKIM for Workspace is enabled in
   Google Admin → *Apps* → *Google Workspace* → *Gmail* → *Authenticate email*.

7. **Widen the allowlist** to the real employee addresses once a message
   arrives, via `NOTIFY_ALLOWED_RECIPIENTS` (comma-separated).

`SMTP_PASS` is already in the redaction list in `lib/agent/verbs/types.ts#scrub`,
so it cannot surface in a logged error message.

## Failure behaviour, as built

| Situation | Inbox item | Email payload | `email_outbox.status` |
|---|---|---|---|
| No provider, or a partial one | written | rendered | `pending`, error `no mail provider is configured` |
| Recipient not on the allowlist | written | rendered | `pending`, error names `NOTIFY_ALLOWED_RECIPIENTS` |
| Provider refuses | written | rendered | `failed`, with the provider's reason |
| Adapter throws | written | rendered | `failed`, with the exception message |
| Provider accepts | written | rendered | `sent`, with `sent_at` |
| No service client at all | none, logged | rendered | not recorded, logged |

Nothing on that table throws at its caller. The event being reported has already
happened by the time notification runs, and a notice must never be able to undo
it.
