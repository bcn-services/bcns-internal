-- ---------------------------------------------------------------------------
-- 0019_quoting_stage — add `quoting` to the businesses stage vocabulary.
--
-- jobs/notify.mjs already reads a `quoting` backlog every tick and the quote
-- handoff sets that stage, but 0018's businesses_stage_check lists only
-- `quoted`, so the write would be rejected and the handoff template could never
-- fire on real data. 0018 is applied and is never edited; this is the additive
-- follow-up.
--
-- `quoting` is the work-in-progress state: Brandon's notes are in and the quote
-- is being written. `quoted` stays what it was — the quote has gone out.
--
-- Widening a CHECK only. Every existing row already satisfies the wider set, so
-- the constraint is added valid rather than `not valid`, and no row moves.
-- ---------------------------------------------------------------------------

begin;

alter table businesses drop constraint businesses_stage_check;

alter table businesses add constraint businesses_stage_check check (stage in (
  'sourced',
  'qualified',
  'call_due',
  'drafted',
  'approved',
  'sent',
  'replied',
  'quoting',
  'meeting',
  'quoted',
  'won',
  'lost'
));

commit;
