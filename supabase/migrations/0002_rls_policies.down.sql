-- 0002_rls_policies.down.sql — exact inverse of 0002_rls_policies.sql.
-- Policies drop first, then the helper functions they call. Dropping in the
-- other order would fail: a policy depends on the function in its expression.
drop policy if exists account_activity_staff_insert on account_activity;
drop policy if exists accounts_staff_update         on accounts;
drop policy if exists accounts_staff_insert         on accounts;
drop policy if exists account_activity_staff_select on account_activity;
drop policy if exists clients_staff_select          on clients;
drop policy if exists accounts_staff_select         on accounts;
drop policy if exists account_activity_admin_all    on account_activity;
drop policy if exists clients_admin_all             on clients;
drop policy if exists accounts_admin_all            on accounts;
drop function if exists auth.is_staff();
drop function if exists auth.is_admin();
drop function if exists auth.role_claim();
