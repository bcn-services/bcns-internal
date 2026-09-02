-- ---------------------------------------------------------------------------
-- 0022_pipeline_v2 — the columns the post-approval pipeline writes.
--
-- The approval step is gone: `touch` sends a draft at 14:00 without anyone
-- being asked, so nothing writes `approved` any more. It stays in the CHECK
-- below because rows written before this migration may still carry it, and a
-- constraint that invalidates existing rows is a failed migration, not a
-- cleanup. Nothing sets it; nothing has to clear it.
--
-- WHAT IS ACTUALLY NEW IN THE STAGE LIST. Only `onboarded`. `quoted` has been
-- in the vocabulary since 0018 and survived 0019's widening — it is re-listed
-- here because widening a CHECK means re-stating the whole set, not because it
-- is being added. `onboarded` is where a won business lands once its repo and
-- its ~/os index exist: `won` is "they said yes", `onboarded` is "the machinery
-- for them is built".
--
-- WHY `os_slug` LIVES ON `businesses`. The onboard job generates a client repo
-- and a ~/os/clients/<slug>/ index from a won business, and needs to know, on
-- the funnel row, which slug that was — otherwise a re-run generates a second
-- repo for the same business. UNIQUE because one slug names one business; TEXT
-- and nullable because the overwhelming majority of funnel rows never get one.
-- It deliberately does not reference clients.slug: the funnel row gets a slug
-- at repo-generation time, which is before the clients row exists, and a FK
-- would make the write order the constraint.
--
-- WHY THE THREE `clients` COLUMNS. 0020 recorded what a client is worth and
-- when they churned, and nothing about the paperwork. `signed_at` is when the
-- contract came back (timestamptz, not date: it is an event, and 0020's
-- launch_date/churn_date are the billing-period boundaries, which are days).
-- `contract_path` is where the signed PDF was filed, `repo_url` the repo the
-- onboard job created. All three nullable: a client row can exist before any
-- of them is known, and an invented path is worse than a blank a human fills.
--
-- RLS: unchanged and deliberately so. `businesses` (0018) and `clients` (0020)
-- are both RLS-on with no policies at all — deny-all for anon and
-- authenticated, service role bypasses. New columns on those tables are
-- reachable by exactly what could already reach the tables, so widening the
-- stage CHECK adds no writer. There is no policy naming `stage` to re-audit.
--
-- Additive only. 0018/0019/0020 are applied and are never edited; the stage
-- CHECK is replaced rather than edited in place, the same way 0019 did it, and
-- every existing row already satisfies the wider set.
-- ---------------------------------------------------------------------------

begin;

-- The funnel row's link to ~/os/clients/<slug>/ and bcns-client-<slug>.
alter table businesses add column os_slug text unique;

-- The paperwork behind a signed client.
alter table clients add column signed_at     timestamptz;
alter table clients add column contract_path text;
alter table clients add column repo_url      text;

-- Stage vocabulary: 0019's twelve, plus `onboarded`.
alter table businesses drop constraint businesses_stage_check;

alter table businesses add constraint businesses_stage_check check (stage in (
  'sourced',
  'qualified',
  'call_due',
  'drafted',
  'approved',
  'sent',
  'replied',
  'quoting',
  'meeting',
  'quoted',
  'won',
  'onboarded',
  'lost'
));

commit;
