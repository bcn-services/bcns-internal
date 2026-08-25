-- ---------------------------------------------------------------------------
-- 0006_seed_clients — the real bcns client roster.
--
-- WHY THIS IS A MIGRATION AND NOT A SCRIPT. The lead backfill came from a
-- spreadsheet and is genuinely imported data. These five rows are not: they are
-- facts about the business that were only ever written down in ~/os client
-- README frontmatter, which no server can read. Putting them here makes the
-- database self-sufficient and makes a fresh environment come up populated.
--
-- Every client needs an `accounts` row first, because clients.account_id is
-- NOT NULL — a client IS an account that bought. None of these five came from
-- Google Places, so place_id is left NULL, which the partial unique index on
-- accounts.place_id explicitly permits.
--
-- MONTHLY RATES ARE MOSTLY NULL, ON PURPOSE. Only Coventry's rate ($100/mo
-- founding-client) is written down anywhere. Guessing the others would put
-- invented billing figures in the system of record, which is worse than a blank
-- a human fills in. NULL here means "not recorded yet", not "free".
--
-- Idempotent: re-running changes nothing. Safe to apply to a database that
-- already has some of these rows.
-- ---------------------------------------------------------------------------

-- status 'won' is the terminal funnel stage for a business that signed, which
-- is true of all five regardless of where delivery stands.
-- NOT `on conflict do nothing`: business_name carries no unique constraint, so
-- there is no conflict for Postgres to detect and a second apply would insert a
-- second full set of duplicates. `where not exists` is the guard that actually
-- holds on this table.
insert into accounts (business_name, business_type, city, website, status, notes)
select v.business_name, v.business_type, v.city, v.website, 'won', v.notes
from (values
  ('L2 Detailz', 'Auto Detailing', null::text, 'https://l2details.com',
   'Hosted-web client. Seeded from ~/os/clients/bcns-client-l2detailz.'),
  ('Coventry Painting & General Contracting', 'General Contractor', null::text, null::text,
   'Hosted-web client. Seeded from ~/os/clients/bcns-client-coventry.'),
  ('DeLuca''s', 'Restaurant', null::text, null::text,
   'Pre-hosting era: handed-off Electron desktop app, reactive support, no monthly hosting relationship.'),
  ('Technology Associates', null::text, null::text, null::text,
   'Hosted-web client. Seeded from ~/os/clients/bcns-client-technology-associates.'),
  ('Wholesale Window Company', null::text, null::text, null::text,
   'Hosted-web client. Seeded from ~/os/clients/bcns-client-wwc.')
) as v(business_name, business_type, city, website, notes)
where not exists (
  select 1 from accounts a where a.business_name = v.business_name
);

-- Join back by business_name rather than hardcoding UUIDs, so this works
-- whether or not the inserts above actually fired.
insert into clients (account_id, slug, status, monthly_rate_cents, domain, repo, droplet_host, notes)
select a.id, v.slug, v.status, v.rate, v.domain, v.repo, v.droplet, v.notes
from (values
  -- Live and serving. The only one past launch.
  ('L2 Detailz', 'l2detailz', 'active', null::bigint, 'l2details.com',
   'bcn-services/bcns-client-l2detailz', '146.190.138.141',
   'Live. Monthly rate not recorded in ~/os — fill in.'),
  -- Signed and building; not launched, so 'onboarding' rather than 'active'.
  ('Coventry Painting & General Contracting', 'coventry', 'onboarding', 10000::bigint, null,
   'nseluga/bcns-client-coventry', null,
   '$100/mo founding-client rate, per the Coventry README.'),
  -- Maintenance only. Kept as a client because the relationship is real, even
  -- though there is no hosting fee attached to it.
  ('DeLuca''s', 'delucas', 'active', null::bigint, null,
   'nseluga/bcns-client-delucas', null,
   'Handed-off desktop app. Reactive support, not a hosting relationship.'),
  ('Technology Associates', 'technology-associates', 'onboarding', null::bigint, null,
   'bcn-services/bcns-client-technology-associates', null,
   'Scoping: business brief and config decisions still open.'),
  ('Wholesale Window Company', 'wwc', 'onboarding', null::bigint, null,
   'nseluga/bcns-client-wwc', null,
   'Scoping: order schema and email-integration approach still open.')
) as v(business_name, slug, status, rate, domain, repo, droplet, notes)
join accounts a on a.business_name = v.business_name
on conflict (slug) do nothing;
