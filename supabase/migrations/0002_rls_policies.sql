-- 0002_rls_policies.sql
-- Purpose: the RLS policy layer for the bcns internal dashboard. RLS was ENABLED
--   default-deny in 0001; this migration adds the actual policies.
--
-- Authorization model (two trusted paths, keep BOTH) — copied deliberately from
-- bcns-client-coventry/supabase/migrations/0003_rls_policies.sql so the internal
-- app and the client apps share one authorization pattern:
--   * service_role  — bypasses RLS entirely; the server-side backend path.
--                     NEVER shipped to a browser bundle.
--   * authenticated — interactive users (admin + member) hit the DB under RLS.
--                     admin vs member is decided by the SERVER-CONTROLLED JWT
--                     claim app_metadata.role, settable only via the service-role
--                     Admin API (scripts/set-user-role.mjs), never user_metadata.
--                     user_metadata is user-writable and is NOT a security claim.
--
-- Two roles only, per the plan:
--   admin  (Nate)     — full read/write/delete on everything.
--   member (everyone) — reads everything; works leads (insert/update accounts and
--                       activity); may NOT edit the commercial terms on clients,
--                       and may NOT delete anything.
--
-- Deliberately NOT done here: hiding money columns from members. Coventry revokes
--   column SELECT to hide job financials from subcontractors. Members here are
--   trusted staff who need deal values to do their job. If that changes, the
--   mechanism to copy is coventry's column-GRANT layer, not a policy.
--
-- Dependencies: FIRST migration to reference the Supabase `auth` schema. Requires
--   auth.jwt() to exist (Supabase provides it; the test harness emulates it).
-- Reversible via 0002_rls_policies.down.sql.

-- ---------------------------------------------------------------------------
-- Authorization helpers. STABLE (the JWT is constant within a statement) and
-- pinned to an empty search_path, so every reference is schema-qualified.
-- Defined in `public`, NOT in `auth`: Supabase revoked CREATE on the auth
-- schema from the postgres role, so `create function auth.is_staff()` fails
-- with "permission denied for schema auth" against a real project. Supabase
-- also documents the auth schema as theirs to manage. Calling auth.jwt() from
-- public is unaffected -- only creating objects there is denied.
-- ---------------------------------------------------------------------------

-- role_claim(): the raw app_metadata.role claim, '' when absent. coalesce guards
-- an anonymous or unprovisioned session so downstream comparisons never see NULL.
create or replace function public.role_claim()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
$$;

-- is_admin(): true iff the claim is exactly 'admin'.
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.role_claim() = 'admin';
$$;

-- is_staff(): true for admin OR member. An unprovisioned authenticated user
-- (invited but never assigned a role) matches NEITHER and therefore sees zero
-- rows — fail-safe, and the reason an unknown claim must not default to member.
create or replace function public.is_staff()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.role_claim() in ('admin', 'member');
$$;

-- ---------------------------------------------------------------------------
-- ADMIN: full read/write on every table.
-- FOR ALL with USING (visibility + the row targeted by UPDATE/DELETE) and
-- WITH CHECK (rows produced by INSERT/UPDATE). A non-admin fails both and falls
-- through to the member policies below.
-- ---------------------------------------------------------------------------
create policy accounts_admin_all on accounts
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy clients_admin_all on clients
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy account_activity_admin_all on account_activity
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- MEMBER: read everything. Postgres OR-combines permissive policies, so these
-- union with the admin FOR ALL policies — an admin still sees everything.
-- ---------------------------------------------------------------------------
create policy accounts_staff_select on accounts
  for select to authenticated using (public.is_staff());

create policy clients_staff_select on clients
  for select to authenticated using (public.is_staff());

create policy account_activity_staff_select on account_activity
  for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------------
-- MEMBER writes: leads only. Members prospect and work the funnel, so they add
-- and edit accounts and log activity. There is NO member DELETE policy anywhere
-- and NO member write policy on clients — removing a business or changing what
-- a client pays is an admin act.
-- ---------------------------------------------------------------------------
create policy accounts_staff_insert on accounts
  for insert to authenticated with check (public.is_staff());

create policy accounts_staff_update on accounts
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy account_activity_staff_insert on account_activity
  for insert to authenticated with check (public.is_staff());
