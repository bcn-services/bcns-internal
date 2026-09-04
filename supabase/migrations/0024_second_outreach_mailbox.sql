-- Item 22 — placeholder row for a second outreach domain. `status = 'paused'`
-- (the schema has no boolean `active` flag — see 0018_pipeline.sql — `paused`
-- is the value `activeMailboxes()`/`claimMailboxSlot` never selects) so this
-- mailbox is never claimed until a human renames the address, points its DNS
-- at a real domain, and flips status to 'active' by hand.
insert into mailboxes (address, domain, status)
values ('outreach@bcns-mail.example', 'bcns-mail.example', 'paused');
