-- Reverse of 0004_profiles. Drop the dependent column before the table it
-- references, or the foreign key blocks the drop.
drop index if exists accounts_assigned_to_idx;
alter table accounts drop column if exists assigned_to;

drop policy if exists profiles_admin_all on profiles;
drop policy if exists profiles_staff_select on profiles;
drop trigger if exists profiles_set_updated_at on profiles;
drop table if exists profiles;
