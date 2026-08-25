-- Undo 0010: restore 0002's admin FOR ALL policy exactly, and remove the
-- append-only trigger. After this the audit trail is admin-writable again.
drop trigger if exists account_activity_guard_insert on account_activity;
drop function if exists public.account_activity_guard();

drop policy if exists account_activity_admin_select on account_activity;

create policy account_activity_admin_all on account_activity
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
