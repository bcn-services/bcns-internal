-- ---------------------------------------------------------------------------
-- 0017_reset — drop the command-center application schema.
--
-- Migrations 0001-0016 built a staff dashboard: accounts, clients, tasks,
-- inboxes, lead targets, outreach drafts. None of it is part of the outreach
-- pipeline, and leaving it in place would leave policies and triggers firing
-- against tables nothing reads.
--
-- Scope is exactly the objects those migrations created in `public`. Nothing
-- Supabase itself owns is dropped, and no schema is dropped at all.
--
-- CASCADE is deliberate. The drop order below is dependency-correct on its
-- own, but each table carries policies, triggers, indexes and foreign keys
-- that must go with it, and a leftover dependency would block 0018.
-- ---------------------------------------------------------------------------

begin;

drop table if exists account_activity cascade;
drop table if exists agent_tokens cascade;
drop table if exists email_outbox cascade;
drop table if exists inbox_items cascade;
drop table if exists job_runs cascade;
drop table if exists outreach_drafts cascade;
drop table if exists lead_targets cascade;
drop table if exists project_notes cascade;
drop table if exists project_overrides cascade;
drop table if exists project_settings cascade;
drop table if exists tasks cascade;
drop table if exists clients cascade;
drop table if exists profiles cascade;
drop table if exists accounts cascade;

drop function if exists public.account_activity_guard() cascade;
drop function if exists public.pause_outreach_on_human_activity() cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.is_staff() cascade;
drop function if exists public.role_claim() cascade;
drop function if exists public.set_updated_at() cascade;

commit;
