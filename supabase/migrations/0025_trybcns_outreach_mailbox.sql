-- Second outreach domain, for real this time: trybcns.com already has MX at
-- Google. Seeded `paused` so the touch job never claims it until a human has
-- (1) added outreach@trybcns.com as a send-as alias on the sending seat,
-- (2) published SPF, DKIM and DMARC for trybcns.com, and (3) flipped this row
-- to 'active' — see docs/NOTIFICATIONS.md "Switching the outreach domain".
-- The 0024 placeholder stays: a paused row costs nothing and deleting is
-- forbidden.
insert into mailboxes (address, domain, status)
values ('outreach@trybcns.com', 'trybcns.com', 'paused');
