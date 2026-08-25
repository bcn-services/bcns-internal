-- 0003_project_manual.sql
-- Purpose: the manual layer for the project board — the human edits that sit on
--   top of what the filesystem says. Ported from project-dashboard's
--   src/lib/manual.ts, which kept all of this in a single JSON file on one
--   laptop behind an in-process mutex.
--
-- Why this exists: `~/os/projects/*/README.md` is the source of truth for a
--   project, but a README is a file someone has to edit. The dashboard let you
--   correct a field, set a due date, hide a field, or leave a note from the UI.
--   That state has to outlive the laptop, so it lands here.
--
-- project_id is TEXT and has NO foreign key. Projects are directories under
--   OS_DIR, not rows — see lib/os/paths.ts. A FK would require mirroring the
--   filesystem into Postgres, which is the thing this app deliberately does not
--   do. The cost is that an override can outlive its project; that is a stale
--   row, not corruption, and the read path simply never joins it.
--
-- The mutex is gone, not ported. `insert ... on conflict do update` is atomic
--   in Postgres, so the whole reason for the file lock (read-modify-write of one
--   big JSON blob) no longer exists.
--
-- Deliberately NOT ported from ManualData: `inbox` and `token_log`. Both are
--   personal-machine features (a capture inbox, Claude token accounting), not
--   company records, and nothing in the internal dashboard reads them.
--
-- Reversible via the paired 0003_project_manual.down.sql.

-- ---------------------------------------------------------------------------
-- project_overrides: one row per overridden field. A row-per-field rather than
-- a jsonb blob so the CHECK below is a real database constraint — the Astro
-- version enforced the allowed-field list only in the API handler, which meant
-- the file could hold anything a second writer put there.
--
-- Clearing an override is a DELETE of its row, which is why `value` is NOT NULL:
-- a NULL value and an absent row would otherwise mean the same thing twice.
-- ---------------------------------------------------------------------------
create table project_overrides (
  project_id  text not null check (project_id <> ''),
  field       text not null
    check (field in ('name', 'summary', 'status', 'priority', 'next_step', 'repo', 'github')),
  value       text not null,
  updated_by  text,
  -- created_at is not decoration: the shared set_updated_at() trigger holds it
  -- immutable with `new.created_at = old.created_at`, and PL/pgSQL raises
  -- "record new has no field created_at" on a table that lacks it. A table with
  -- that trigger must have both columns.
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (project_id, field)
);

-- ---------------------------------------------------------------------------
-- project_settings: the per-project knobs that are not field overrides. The
-- Astro version kept these as two separate maps (`due_dates`, `hidden_fields`);
-- they are one row here because they are always read together and a single
-- upsert is cheaper than two.
--
-- due_date is a real DATE, not the YYYY-MM-DD string the JSON file held, so a
-- malformed date is rejected by the database instead of by a regex in a handler.
-- ---------------------------------------------------------------------------
create table project_settings (
  project_id    text primary key check (project_id <> ''),
  due_date      date,
  hide_due_date boolean not null default false,
  hide_priority boolean not null default false,
  updated_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- project_notes: freeform notes, optionally attached to a project.
--
-- project_id is NULLABLE and NULL means "unsorted" — the Astro version
-- auto-tagged a note to a project by matching its text against project names,
-- and left it null when nothing matched. That auto-tagging is NOT ported: it
-- guessed, and a wrong guess files a note where nobody looks for it. A note
-- starts unsorted and a human assigns it.
--
-- The 2000-character cap is the MAX_NOTE_LENGTH the API handler enforced,
-- moved into the schema where a second writer cannot skip it.
-- ---------------------------------------------------------------------------
create table project_notes (
  id           uuid primary key default gen_random_uuid(),
  project_id   text check (project_id is null or project_id <> ''),
  body         text not null check (char_length(body) between 1 and 2000),
  author_email text,
  created_at   timestamptz not null default now()
);

create index project_notes_created_idx on project_notes (created_at desc);
create index project_notes_project_idx on project_notes (project_id, created_at desc);

create trigger project_overrides_set_updated_at
  before update on project_overrides
  for each row execute function set_updated_at();

create trigger project_settings_set_updated_at
  before update on project_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Same two-path model as 0002: service_role bypasses, `authenticated` is
-- gated on the app_metadata.role claim via the public.is_* helpers.
-- ---------------------------------------------------------------------------
alter table project_overrides enable row level security;
alter table project_settings  enable row level security;
alter table project_notes     enable row level security;

create policy project_overrides_admin_all on project_overrides
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy project_settings_admin_all on project_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy project_notes_admin_all on project_notes
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy project_overrides_staff_select on project_overrides
  for select to authenticated using (public.is_staff());

create policy project_settings_staff_select on project_settings
  for select to authenticated using (public.is_staff());

create policy project_notes_staff_select on project_notes
  for select to authenticated using (public.is_staff());

-- Members write all three. This is the one place the "members never DELETE"
-- rule from 0002 does not apply, and the difference is deliberate: an override
-- row and a settings row are display state, so clearing one is an UNSET, not
-- the destruction of a record. `accounts` and `clients` are still admin-delete
-- only, and nothing here touches them.
create policy project_overrides_staff_write on project_overrides
  for insert to authenticated with check (public.is_staff());

create policy project_overrides_staff_update on project_overrides
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy project_overrides_staff_delete on project_overrides
  for delete to authenticated using (public.is_staff());

create policy project_settings_staff_write on project_settings
  for insert to authenticated with check (public.is_staff());

create policy project_settings_staff_update on project_settings
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy project_settings_staff_delete on project_settings
  for delete to authenticated using (public.is_staff());

create policy project_notes_staff_write on project_notes
  for insert to authenticated with check (public.is_staff());

-- A note is a record, so members do NOT get a blanket delete here — only their
-- own. author_email is compared against the JWT's email claim, which the client
-- cannot forge: it is signed by Supabase, not supplied by the form. A note with
-- a NULL author (service-role import) matches nobody and is admin-only.
create policy project_notes_own_delete on project_notes
  for delete to authenticated
  using (public.is_staff() and author_email is not null
         and author_email = (auth.jwt() ->> 'email'));

-- Reassigning a note to a project is an edit any member may make.
create policy project_notes_staff_update on project_notes
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
