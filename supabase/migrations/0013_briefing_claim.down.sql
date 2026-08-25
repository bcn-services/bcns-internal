-- Reverses 0013_briefing_claim.
--
-- Dropping the claim column loses only "when did the briefing last try", never
-- "when was somebody last briefed" — that is `last_briefed_at`, added by 0009
-- and untouched here. The cost of running this is one extra briefing per
-- employee: with no claim recorded, the next login is an unthrottled first run.

alter table profiles
  drop column if exists briefing_claimed_at;
