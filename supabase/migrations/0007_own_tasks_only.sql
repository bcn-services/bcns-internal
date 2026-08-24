-- ---------------------------------------------------------------------------
-- 0007_own_tasks_only — a member changes their own work, and only their own.
--
-- WHAT CHANGED AND WHY. 0005 gave every member update on every task
-- (`tasks_staff_update` used `public.is_staff()` on both sides), and its own
-- comment named that as a choice to tighten later. This is that tightening.
-- The command center has a real assignment flow now: an admin hands work out,
-- and a member moves their queue along. Under the old policy any member could
-- silently mark a colleague's task done, and nothing in the app or the audit
-- trail would say who did it.
--
-- READ IS UNTOUCHED. `tasks_staff_select` still shows everyone the whole board.
-- Seeing a colleague's task on the same client is the point of a shared board;
-- what is being removed is the ability to *change* it.
--
-- WHY auth.uid() AND NOT A PROFILE LOOKUP. `profiles.id` IS the auth user id
-- (0004 declares it `references auth.users (id)`), so the comparison needs no
-- join and no helper. A helper here would be a second place for identity to be
-- decided, and identity already has one.
--
-- BOTH SIDES OF THE POLICY MATTER, and they say different things:
--   USING       — which existing rows you may touch: the ones assigned to you.
--   WITH CHECK  — what the row may look like afterwards: still assigned to you.
-- Without the WITH CHECK a member could reassign their own task to someone
-- else, which is exactly the admin power this migration exists to reserve.
-- The cost is real and deliberate: a member cannot hand work off or drop it
-- back in the pool. Reassignment is an admin action, and `tasks_admin_all`
-- already covers it.
--
-- INSERT IS UNTOUCHED. A member still files work and may file it against
-- anyone — `tasks_staff_insert` is unchanged. Creating work for a colleague is
-- ordinary collaboration; quietly editing theirs is not.
--
-- STILL NO MEMBER DELETE. Closing a task is a status change to 'cancelled',
-- which keeps the record. Only an admin removes one for good.
-- ---------------------------------------------------------------------------

drop policy if exists tasks_staff_update on tasks;

create policy tasks_staff_own_update on tasks
  for update to authenticated
  using (public.is_staff() and assigned_to = auth.uid())
  with check (public.is_staff() and assigned_to = auth.uid());
