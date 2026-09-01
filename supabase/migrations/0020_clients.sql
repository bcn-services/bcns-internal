-- ---------------------------------------------------------------------------
-- 0020_clients — the paying roster, and the money facts about it.
--
-- 0017 dropped `accounts` and `clients`, and with them the only two money
-- columns this database ever had: accounts.deal_value_cents and
-- clients.monthly_rate_cents. That drop was right — it removed a staff
-- dashboard the pipeline never used — but nothing replaced the money. Today
-- the sole revenue record is businesses.research->>'won_amount', a JSON number
-- in dollars written by jobs/poll.mjs, which contradicts the 0001 platform
-- rule that money is integer cents in a bigint.
--
-- WHY THIS IS NOT A STAGE ON `businesses`. `businesses.stage` is the outreach
-- funnel: stranger to signed. It ends at `won`. What a client is worth, and
-- when they stopped paying, is not a funnel position, and folding it into
-- `stage` would make one column mean two unrelated things.
--
-- WHY THERE IS NO `status` COLUMN HERE. Lifecycle status already lives in
-- ~/os/clients/<slug>/README.md frontmatter (lead | in-progress | on-hold |
-- dormant | complete | lost). A status column here would be the same fact
-- written down twice, and the two copies would drift — which is exactly the
-- drift that put five wrong statuses in those READMEs. So the split is:
-- Postgres owns money, the README owns lifecycle, and `slug` is the only thing
-- they share. Nothing has to sync because nothing overlaps.
--
-- `churn_date` is what replaces the dropped status = 'churned'. It is a money
-- fact, not a label: churn_date is null means we are still being paid, which
-- is the filter profit tracking actually needs. It agrees with a README marked
-- `dormant` without either side reading the other.
--
-- COSTS ARE NOT HERE YET, ON PURPOSE. Per-client profit needs a periodic
-- ledger with a NULLABLE client_id, because some costs belong to no client
-- (Supabase's $25 org base, the $5 Spaces bucket, the Sentry seat) while
-- others are per-client (a droplet, a Supabase project). That table can be
-- added later without touching this one, so building it now buys nothing.
-- ---------------------------------------------------------------------------

begin;

create table clients (
  id                 uuid primary key default gen_random_uuid(),

  -- matches the folder name in ~/os/clients/ AND the repo bcns-client-<slug>,
  -- so a client row, its index and its repo are recognisably the same thing.
  slug               text not null unique
                       check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  display_name       text not null,

  -- the funnel row this client came from, when they came from outreach at all.
  -- NULL for the clients that predate the pipeline. UNIQUE because one won
  -- business becomes one client, never two.
  business_id        uuid unique references businesses (id) on delete set null,

  -- Contracted amounts — what they agreed to pay, not what was collected.
  -- Integer cents per the 0001 platform rule. NULL means "not recorded yet",
  -- never "free"; a guessed rate would put an invented billing figure in the
  -- system of record, which is worse than a blank a human fills in.
  build_fee_cents    bigint check (build_fee_cents is null or build_fee_cents >= 0),
  monthly_rate_cents bigint check (monthly_rate_cents is null or monthly_rate_cents >= 0),

  launch_date        date,
  churn_date         date,
  notes              text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint clients_churn_after_launch
    check (churn_date is null or launch_date is null or churn_date >= launch_date)
);

-- The paying roster. Partial, because "who is billing us this month" is the
-- only read profit tracking makes often, and churned rows never answer it.
create index clients_paying_idx on clients (slug) where churn_date is null;

-- Same posture as every table in 0018: RLS on, no policies at all. anon and
-- authenticated get nothing; the service role bypasses RLS entirely. Deny-all
-- is the absence of a policy, not a policy that returns false.
alter table clients enable row level security;

-- ---------------------------------------------------------------------------
-- The roster as of 2026-09-01, from the ~/os client READMEs.
--
-- Coventry is deliberately absent. The 0006 seed asserted Coventry as a live
-- client at the $100/mo founding rate; that is now known to be false — they
-- were pursued through pitch, quote and a generated repo and never signed, and
-- their README carries status: lost. A lost deal has no clients row.
--
-- Only SB's amounts are written down anywhere ($750 build / $100 mo / $250
-- down). DeLuca's monthly rate is 0 rather than NULL because that is a
-- recorded fact, not a gap: the pre-hosting hand-off era carried no monthly
-- hosting relationship. The other three are NULL — fill them in.
--
-- Idempotent: on conflict on the unique slug, do nothing.
-- ---------------------------------------------------------------------------
insert into clients (slug, display_name, build_fee_cents, monthly_rate_cents, notes)
values
  ('sb',                    'SB',                        75000, 10000,
   'Signed at the early-client rate: $750 build, $100/mo, $250 down. Repo not generated yet.'),
  ('wwc',                   'Wholesale Window Company',   null,  null,
   'Signed; still scoping what they want. Rate not recorded — fill in.'),
  ('technology-associates', 'Technology Associates',      null,  null,
   'Signed; build planned. Rate not recorded — fill in.'),
  ('l2detailz',             'L2 Detailz',                 null,  null,
   'Delivered. Rate not recorded — fill in.'),
  ('delucas',               'DeLuca''s',                  null,  0,
   'Pre-hosting era: handed-off Electron desktop app, reactive support, no monthly hosting relationship.')
on conflict (slug) do nothing;

commit;
