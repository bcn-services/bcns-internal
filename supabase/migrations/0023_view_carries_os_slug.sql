-- `select *` in a view is expanded when the view is created, so
-- selectable_businesses stopped at the columns 0018 knew about and never
-- gained 0022's os_slug. Recreating it re-expands the star. Same filter.
create or replace view selectable_businesses as
  select * from businesses where suppressed_at is null;
