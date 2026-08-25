-- Reverse of 0005_tasks. Policies and trigger go with the table, but drop them
-- explicitly so a partial apply can still be rolled back.
drop policy if exists tasks_staff_update on tasks;
drop policy if exists tasks_staff_insert on tasks;
drop policy if exists tasks_staff_select on tasks;
drop policy if exists tasks_admin_all on tasks;
drop trigger if exists tasks_set_updated_at on tasks;
drop table if exists tasks;
