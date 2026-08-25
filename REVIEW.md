# REVIEW — bcns command center, first draft

Branch `command-center`. Built in one unattended run against `LANE.md`, 13 items.
Nothing here has been deployed, pushed, or applied to production.

**Read the "Verified vs. merely built" section before you trust anything below it.**

---

## Gates, as I measured them

| Gate | Result |
|---|---|
| `corepack pnpm test` | **893 pass · 0 fail · 0 skipped · 147 suites** (was 217 at the start) |
| `corepack pnpm typecheck` | clean |
| `corepack pnpm lint` | exactly **5** errors, all pre-existing — see below |
| `corepack pnpm build` | compiled successfully, 13 pages |

The 5 lint errors predate this work and were deliberately not "fixed":
`lib/accounts.ts:145`, `lib/os/osFiles.ts:514`, `tests/accounts-data-layer.test.mjs:13`,
`tests/rls-policies.test.mjs:66` and `:100`.

0 skipped matters: a skipped test is one that silently did not run.

---

## Item status

| # | Item | Status |
|---|---|---|
| 1 | Migration harness + production ledger backfill | done |
| 2 | Migration 0009 — automation schema | done |
| 3 | Agent verb layer | done |
| 4 | Activity capture and parsing | done |
| 5 | Skill buttons and job-function gating | done |
| 6 | Inbox | done |
| 7 | Notification routing | **done except sending — blocked** |
| 8 | Daily briefing | done — **skill file staged, not installed** |
| 9 | Job runner and first three jobs | done |
| 10 | Lead outreach lanes and the sweep | done |
| 11 | README export generator | done — **commit path untested against the real repo** |
| 12 | Admin configuration surface | done |
| 13 | Final integration pass | done |

### Items that carried `caution: true`

These six were built by one agent, independently verified by a second that did not
build them, and reviewed by a third. Named here for your review whatever the outcome.

| # | Item | QA verdict |
|---|---|---|
| 1 | Migration harness | PASS |
| 2 | Migration 0009 | PASS |
| 3 | Agent verb layer | PASS — review found and closed two SSRF holes |
| 4 | Activity capture | PASS — review found the audit trail was not trustworthy; fixed |
| 6 | Inbox | PASS — review found the cached-service-client pattern unsafe to copy; fixed |
| 10 | Outreach lanes | PASS — review found the draft batch could never advance; fixed |

Every review finding was either fixed or recorded as a deliberate deferral. No
finding was silently dropped.

---

## Verified vs. merely built

This is the honest line, and it is the most important section here.

**Genuinely verified end to end**
- Everything with a test, which is all 893. Database behaviour is tested against a
  real throwaway Postgres cluster with real RLS policies and real triggers, not a mock.
- All 8 migrations `0009`–`0016` replay forward, and all 8 roll back.
- The `/admin` token and job-history panels are rendered to real HTML and asserted
  against — including a test that feeds the panel a record actually carrying a sealed
  token, renders it, and greps the output for those bytes.
- Race safety, twice, with genuinely concurrent database sessions: the briefing claim
  (item 8) and the job window (item 9).

**Compiles, but not proven to paint**
`/`, `/leads`, `/clients`, `/clients/[slug]`, `/tasks`, `/inbox`, and every `/api/*`
route. They compile and appear in the build output, and the seed leaves non-empty rows
in exactly the tables they query — but no page was ever loaded in a browser during
this run. A headless agent cannot run `next dev`. **Nothing here proves a page paints,
that the unread badge shows a number, or that a query succeeds through PostgREST.**
That is what your click-through below is for.

**There is no `/activity` route.** `app/activity/` holds server actions only. It never
had a page; nothing regressed.

---

## Blockers

**1. Notification sending — item 7.**
No mail provider is configured, and configuring Resend needs an interactive signup
this run was not permitted to perform. Routing works and is tested: the system decides
inbox vs. email correctly. Emails that have nowhere to go are written out in full and
parked in `email_outbox` with status `pending` — distinct from `failed`, which means a
provider actually refused. Nothing is lost. `docs/NOTIFICATIONS.md` has the 12 steps.

**2. The briefing skill is staged, not installed — item 8.**
This run was not allowed to write outside `~/bcns-internal`. The skill file sits at
`os-staging/skills/briefing/SKILL.md` with its exact destination path and the verbatim
`INDEX.md` line it needs. **I verified `~/os` is untouched: HEAD `e471073`, nothing
changed under `clients/`.**

**3. The README export generator has never run against the real `~/os` — item 11.**
Same reason. Commits were exercised against a throwaway git repo. The generator takes
its os-root as a parameter and has no `~/os` fallback, so it cannot write there by
accident.

---

## Deliberate omissions — things I chose not to do

- **The real `leads` skill was never run.** The plan permitted one run; I withdrew that
  permission because no acceptance criterion needed it and it costs real budget and
  real network calls. Everything is tested with injected fakes.
- **Nothing sends to a real lead, and there is no send path at all** — not even a
  dormant one. Drafts are database rows. `outreach_drafts` has no recipient column and
  no `sent_at`. This was verified by grepping the whole diff.
- **No production migration was applied.** `0009` is on production from an earlier
  session; `0010`–`0016` are on disk and unapplied. Review them before applying.
- **No value recorded as unknown was guessed.** Four clients have no `monthly_rate_cents`
  and four have neither `domain` nor `droplet_host`. A test now asserts the seed can
  never quietly fill them.
- **Old `job_runs` rows keep the ambiguous `failed` status.** Item 12 split `attention`
  ("ran fine, found something") out of `failed` ("did not come back"), but existing rows
  cannot be classified after the fact, so they were left alone rather than backfilled
  with a guess.
- **`setLane` writes no activity row**, so a hand lane change leaves no audit trace.
  Writing one would immediately re-trip the pause trigger and flip the lane straight
  back to `paused`. The honest fix is a separate lane-history table; that is not this item.
- **`0012` and `0016` have no committed down-replay test.** Both were verified by hand
  this run, but nothing in the suite guards them.

---

## The one thing most likely to surprise you

**The outreach lane machine is dormant, and that is deliberate.**

A *touch* is an `ai_email_sent` activity row. A *draft* is an `outreach_drafts` row.
Nothing in this repo turns the first into the second, because nothing sends. So in
practice every lead sits at touch 1 and the three-touch cap never engages.

This was flagged, reviewed, and kept. The alternative — counting drafts as touches —
would let the system draft touches 2 and 3 and then park a lead **nobody ever emailed**
as `no_response`, which is fabricated history. The cap stays inert until a sender
exists. That is the correct behaviour, but it means the lane machine will look like it
is doing nothing until item 7's blocker is cleared.

---

## How to run it

```sh
cd ~/bcns-internal
git checkout command-center
corepack pnpm install
corepack pnpm dev            # http://localhost:3100
```

To fill every surface with obviously-fake content first:

```sh
SEED_DATABASE_URL=postgres://localhost/bcns_dev corepack pnpm seed-dev
```

The seed refuses any host that is not `localhost` / `127.0.0.1` / `::1` / a unix
socket, so it cannot be pointed at production by accident. All fixture data is
synthetic: invented businesses, `example.com` addresses, `+1-555-01xx` numbers.

**Note:** roles are not seeded. `admin` / `member` live in the JWT's `app_metadata`,
not in the database. Use `corepack pnpm provision-user` — and provision **before**
first sign-in, or the person holds a roleless token.

---

## What to click, in order

1. **Sign in** with your bcns Google account. The home page should appear immediately
   with a briefing card marked as building, then fill itself in. It covers everything
   since your *last* briefing, not "since yesterday".
2. **Look at the sidebar** — the inbox should show an unread count. That count is
   cached, so it should not re-query on every page you open.
3. **Open `/inbox`.** Newest first, unread marked. Click an item; it should link to
   whatever it is about. Reply to one — it should log the contact through the same
   review-before-saving step as the capture box.
4. **Open `/leads`.** Check the lane column: leads should be spread across `ai`,
   `human`, `paused` and `no_response`. Use the lane override buttons to move one by
   hand.
5. **Log an activity in plain English** on a lead — e.g. "called Mike at Coventry
   Tuesday, wants a quote by Friday". It should show you a parsed record for correction
   *before* saving anything. Check the date resolved against your own local date.
6. **Watch that lead's lane flip to `paused`.** Logging human contact on an `ai` lead
   stops the bot — enforced by the database, so it holds however the record was written.
7. **Run a skill from a button** — pitch or quote on a lead or client. Sales and admins
   see the client-facing buttons; developers see none, on purpose, because every
   developer skill needs a cloned repo.
8. **Open `/admin`** (as an admin). Four panels: lead targets, job functions, job
   history, seat status. Confirm the job history shows *attention* as visually distinct
   from *failed*, and that the token panel shows expiry dates and **never** a token value.
9. **Sign in as a member and request `/admin`.** You must get a **403, not a redirect**.
   Also confirm a member cannot change a task they do not own — check that against the
   database, not the UI.
10. **Retire a lead target** in `/admin`, then confirm the leads previously found
    through it are still there. It is a flag flip, never a delete.

---

## What you need to do before the next session

1. **Review migrations `0010`–`0016`** and apply them to production when you are happy.
   They are additive. `0010` makes `account_activity` append-only, which is a real
   behaviour change: after it, nobody — admin included — can edit or delete history.
2. **Install the briefing skill**: copy `os-staging/skills/briefing/SKILL.md` to
   `~/os/skills/briefing/SKILL.md` and add the `INDEX.md` line staged alongside it.
3. **Configure Resend** per the 12 steps in `docs/NOTIFICATIONS.md` to unblock item 7.
   Verify their acceptable-use policy on cold outreach first — transactional providers
   commonly prohibit it, and a suspension would take client mail down too.
4. **Install the cron lines** in `docs/JOBS.md` once a droplet exists. Nothing runs on
   a timer inside the app, by design, so no job has ever fired on a schedule.
5. **Click through the list above.** Ten of the twelve surfaces are proven only to
   compile. This is the gap that tests cannot close.
6. **Supabase Site URL** still reads `http://localhost:3000`; it should be `:3100`.
