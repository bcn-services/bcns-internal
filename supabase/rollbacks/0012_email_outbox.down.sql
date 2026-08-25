-- Reverses 0012_email_outbox.
--
-- Destructive, as a down migration on a new table must be: every record of an
-- email that was rendered and never delivered goes with it, and those are
-- precisely the ones a retry would have sent. Running this is a decision, not a
-- formality. Nothing else references the table; the two indexes and the policy
-- live on it and go with it.

drop table if exists email_outbox;
