-- ---------------------------------------------------------------------------
-- 0004_profiles — the bcns employee directory.
--
-- WHY THIS EXISTS. Staff identity already lives in auth.users, but that table
-- is in the `auth` schema and PostgREST does not expose it. The app therefore
-- cannot read a name from it, which makes "Assigned to: Brandon" impossible to
-- render and gives assignment nothing to reference. This is the standard
-- Supabase mirror: one public row per auth user, holding only what the UI
-- needs to display and what a foreign key needs to point at.
--
-- ROLE IS DELIBERATELY ABSENT. The gate (middleware.ts) and every RLS policy
-- read app_metadata.role out of the JWT. Copying it here would create a second
-- source of truth that is editable over the API, so a compromised member could
-- grant themselves admin by updating their own profile row. app_metadata is
-- writable only by the service role, which is why it holds the role instead.
-- ---------------------------------------------------------------------------

create table profiles (
  -- Same id as the auth user, not a fresh one. Deleting the auth user removes
  -- the profile with it, so a departed employee cannot linger in a picker.
  id            uuid primary key references auth.users (id) on delete cascade,

  -- Mirrored for display and for matching an invite to a person before their
  -- first sign-in. auth.users owns the authoritative copy.
  email         text not null unique,
  display_name  text not null,

  -- Soft offboarding. Deleting the auth user is the hard revoke; this hides
  -- someone from assignment pickers while their existing task history stays
  -- attached and readable.
  active        boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The assignment pickers list active staff by name; this is the only hot query.
create index profiles_active_idx on profiles (active, display_name);

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

alter table profiles enable row level security;

-- Everyone on staff can see the whole directory. Knowing your colleagues'
-- names is a precondition for assigning work to them, and there is nothing
-- sensitive in this table.
create policy profiles_staff_select on profiles
  for select to authenticated using (public.is_staff());

-- Only an admin creates, edits, or deactivates a person. A member editing the
-- directory is an onboarding action, not day-to-day work.
create policy profiles_admin_all on profiles
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Lead ownership. One column, on the table that already exists.
--
-- on delete set null, NOT cascade: removing an employee must never delete the
-- business they were working. The lead survives and returns to unassigned.
-- ---------------------------------------------------------------------------
alter table accounts
  add column assigned_to uuid references profiles (id) on delete set null;

-- Drives "my leads" for every member, which is the most common filtered read.
create index accounts_assigned_to_idx on accounts (assigned_to)
  where assigned_to is not null;
