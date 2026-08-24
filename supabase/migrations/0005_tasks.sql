-- ---------------------------------------------------------------------------
-- 0005_tasks — assignable units of work.
--
-- RELATIONSHIP TO next_step. clients.next_step stays. It answers "what is the
-- single most important thing outstanding for this client" and is what the
-- dashboard shows at a glance. Tasks live underneath it: the full list of work,
-- each owned by one person. next_step is the headline, tasks are the backlog.
-- Neither is derived from the other, so they are allowed to disagree.
--
-- WHY account_id, NOT client_id. Real work starts before a business signs — a
-- pitch to write, a demo to build, a quote to send. Attaching to `accounts`
-- covers prospect work and client work with one foreign key, because every
-- client already has an account row. It is also nullable, because internal work
-- ("configure SMTP") belongs to no business at all.
-- ---------------------------------------------------------------------------

create table tasks (
  id           uuid primary key default gen_random_uuid(),

  -- The business this work is for. NULL means internal bcns work.
  -- on delete cascade: deleting a business should not strand its task list.
  account_id   uuid references accounts (id) on delete cascade,

  title        text not null check (length(trim(title)) > 0),
  details      text,

  -- on delete set null, NOT cascade: an employee leaving must not delete the
  -- work. It returns to unassigned so it can be picked up by someone else.
  assigned_to  uuid references profiles (id) on delete set null,

  -- CHECK-constrained text rather than a PG enum, matching accounts.status —
  -- renaming or adding a stage stays a cheap migration.
  status       text not null default 'todo'
    check (status in ('todo', 'doing', 'done', 'cancelled')),

  due_date     date,

  -- Who created it. Kept for attribution when the assignee is not the author.
  created_by   uuid references profiles (id) on delete set null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- "My open work, soonest first" — the query every member's home page runs.
-- Partial, because a finished task never appears in that list and indexing it
-- would grow the index without bound as work accumulates.
create index tasks_open_by_assignee_idx on tasks (assigned_to, due_date nulls last)
  where status in ('todo', 'doing');

-- "Everything outstanding on this client", for the client detail page.
create index tasks_account_idx on tasks (account_id) where account_id is not null;

create trigger tasks_set_updated_at
  before update on tasks
  for each row execute function set_updated_at();

alter table tasks enable row level security;

-- Admin: full control, including delete.
create policy tasks_admin_all on tasks
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Members read every task, matching how they already read every account. You
-- chose a filter over hard isolation: the UI highlights your own work, and
-- seeing a colleague's task on the same client is the point of a shared board.
-- Tightening this later is a policy change here, not an app rewrite.
create policy tasks_staff_select on tasks
  for select to authenticated using (public.is_staff());

-- Members create work and move it along, including reassigning it. There is
-- deliberately NO member delete policy — closing a task is a status change to
-- 'cancelled', which keeps the record, and only an admin removes it for good.
create policy tasks_staff_insert on tasks
  for insert to authenticated with check (public.is_staff());

create policy tasks_staff_update on tasks
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
