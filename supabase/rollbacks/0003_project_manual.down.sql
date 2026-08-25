-- 0003_project_manual.down.sql — reverses 0003_project_manual.sql.
-- Dropping the tables drops their policies, indexes and triggers with them.
drop table if exists project_notes;
drop table if exists project_settings;
drop table if exists project_overrides;
