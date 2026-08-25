# Notifications — routing, and the blocked send half

The routing layer is built and tested. **Sending is blocked** and will stay
blocked until a human does the twelve steps below, because configuring Resend
needs an interactive signup that an unattended agent is not permitted to do.

Nothing in this repo sends mail today. No provider, no dependency, no key in any
env file. Every email this system decides to send is **rendered in full and
recorded in the `email_outbox` table with status `pending`** — which is why
unblocking the send half is a configuration job, not a rewrite.

---

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

## Configuring Resend — what a human must do

1. Go to <https://resend.com> and sign up (or sign in). The free tier sends 100
   emails a day, which is more than this system will produce.
2. **Add and verify a domain.** Resend → *Domains* → *Add Domain* →
   `bcn-services.com`. Resend prints DKIM, SPF, and a return-path record; add
   all of them at the registrar and wait for the domain to read *Verified*.
   Skipping this and sending from `onboarding@resend.dev` works only to your own
   account's address and will not do for employee mail.
3. **Create an API key.** Resend → *API Keys* → *Create API Key*, permission
   **Sending access**, restricted to the domain from step 2. Copy it once —
   Resend never shows it again.
4. **Set the environment variables.** Four, all server-side; none is
   `NEXT_PUBLIC_*` and none may ever be:

   | Variable | Value | Notes |
   |---|---|---|
   | `RESEND_API_KEY` | the key from step 3 | Secret. Never commit it. |
   | `MAIL_FROM` | e.g. `bcns <notices@bcn-services.com>` | Must be on the verified domain. |
   | `NOTIFY_ADMIN_EMAIL` | Nate's address | Defaults to `nseluga@g.hmc.edu` (`DEFAULT_ADMIN_EMAIL` in `lib/env.ts`). Whatever it is set to is looked up in `profiles` by email; that profile is who "the admin" means. |
   | `NOTIFY_ALLOWED_RECIPIENTS` | comma-separated addresses | **The safety catch.** Any address not on this list is rendered and recorded but never handed to the adapter. Defaults to `nseluga@g.hmc.edu` alone. |

   Where to set them: `.env.local` for local development, and the Vercel
   project's *Settings → Environment Variables* (Production **and** Preview) for
   the deployment. Never stage a `.env` file.

5. **Write the adapter.** In `lib/mailer.ts`, `getMailer()` currently returns
   `nullMailer` even when a key is present — deliberately, so a key alone cannot
   turn into a silent real send. Replace the marked line with an adapter that
   POSTs to `https://api.resend.com/emails`:

   ```ts
   const resendMailer = (key: string, from: string): Mailer => ({
     name: "resend",
     async send({ to, subject, body }) {
       const res = await fetch("https://api.resend.com/emails", {
         method: "POST",
         headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
         body: JSON.stringify({ from, to, subject, text: body }),
       });
       if (!res.ok) return { ok: false, error: `resend ${res.status}: ${await res.text()}`, configured: true };
       return { ok: true, id: (await res.json())?.id };
     },
   });
   ```

   Use `fetchWithTimeout` from `lib/fetch-timeout.ts` rather than bare `fetch`; a
   hung provider must not hold a request open. Return `configured: true` on every
   failure from here — the provider exists, it simply said no.

   Do **not** add the `resend` npm package. The REST call is six lines and a
   dependency is a supply chain.

6. **Apply migration 0012** to production if it is not applied yet:
   `supabase/migrations/0012_email_outbox.sql`. It is purely additive.

7. **Verify a first real send.** With `NOTIFY_ALLOWED_RECIPIENTS` still holding
   only your own address, run one failing job — or from a `tsx` shell:

   ```ts
   import { deliverNotification } from "./lib/notify";
   import { getServiceClient } from "./lib/supabase-admin";
   await deliverNotification(
     { serviceDb: getServiceClient(), caller: { profileId: "<your profile id>", email: "<you>", role: "admin" } },
     { kind: "job_run_failed", inboxProfileId: "<your profile id>", title: "smoke test", body: "ignore me" },
   );
   ```

8. **Check the three places it should show up**, in this order:
   - the return value: `delivered: true` and a non-null `outboxId`;
   - the database: `select status, sent_at, error from email_outbox order by created_at desc limit 1`
     must read `sent`, a timestamp, and `null`;
   - your mailbox.

   If the row says `pending` with an error mentioning
   `NOTIFY_ALLOWED_RECIPIENTS`, the address is not on the allowlist — that is the
   guard working, not a bug. If it says `failed`, the `error` column holds the
   provider's own words.

9. **Widen the allowlist** to the real employees only once step 8 is green:
   `NOTIFY_ALLOWED_RECIPIENTS=nseluga@g.hmc.edu,brandon@bcn-services.com,…`.
   Widen it deliberately. Every address on this list can receive real mail from
   an unattended job.

10. **Drain what accumulated while sending was blocked**, if you want it:
    `select * from email_outbox where status = 'pending' order by created_at`.
    These are real decisions the system made and could not act on. Send them by
    hand, or write the retry job — the `attempts` column exists so a retry can be
    bounded instead of looping.

11. **Never** put any of these keys in `NEXT_PUBLIC_*`, in a client component, or
    in a committed file. `lib/agent/verbs/types.ts#scrub` redacts the Supabase and
    Anthropic keys from error messages; add `RESEND_API_KEY` to that list in the
    same change.

12. **Update this document** to say sending is live, and delete the "blocked"
    header.

---

## Failure behaviour, as built

| Situation | Inbox item | Email payload | `email_outbox.status` |
|---|---|---|---|
| No provider (today) | written | rendered | `pending`, error `no mail provider is configured` |
| Recipient not on the allowlist | written | rendered | `pending`, error names `NOTIFY_ALLOWED_RECIPIENTS` |
| Provider refuses | written | rendered | `failed`, with the provider's reason |
| Adapter throws | written | rendered | `failed`, with the exception message |
| Provider accepts | written | rendered | `sent`, with `sent_at` |
| No service client at all | none, logged | rendered | not recorded, logged |

Nothing on that table throws at its caller. The event being reported has already
happened by the time notification runs, and a notice must never be able to undo
it.
