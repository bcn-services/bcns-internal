-- Reverse of 0007: hand every member update on every task again, exactly as
-- 0005 shipped it.
drop policy if exists tasks_staff_own_update on tasks;

create policy tasks_staff_update on tasks
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
