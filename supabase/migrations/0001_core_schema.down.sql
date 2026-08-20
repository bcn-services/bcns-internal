-- 0001_core_schema.down.sql — exact inverse of 0001_core_schema.sql.
-- Drop order is child-to-parent so no FK blocks the drop. Triggers and indexes
-- fall with their tables; set_updated_at() is dropped last because the triggers
-- depend on it.
drop table if exists account_activity;
drop table if exists clients;
drop table if exists accounts;
drop function if exists set_updated_at();
