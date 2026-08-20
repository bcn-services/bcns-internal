-- 0001_real_clients.sql — the five clients bcns actually hosts today.
--
-- Development seed ONLY. Never run against production: it invents no money and
-- no contact history, so applying it over real rows would present placeholders
-- as facts. Every account below is inserted at status 'won' because each one is
-- already a client; the funnel columns are left null rather than guessed.
--
-- Slugs match the repo names (bcns-client-<slug>) so a client row and its repo
-- are recognisably the same thing.
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/0001_real_clients.sql
-- Re-runnable: both inserts are ON CONFLICT DO NOTHING.

begin;

insert into accounts (id, business_name, business_type, status, notes)
values
  ('a0000000-0000-4000-8000-000000000001', 'Coventry',                'landscaping',  'won',
   'Repo bcns-client-coventry. Furthest-along build: jobs, deposits, QBO invoicing, field login.'),
  ('a0000000-0000-4000-8000-000000000002', 'DeLuca''s',               null,           'won',
   'Repo bcns-client-delucas. Diverges from the template by swapping preset HSL values.'),
  ('a0000000-0000-4000-8000-000000000003', 'L2 Detailz',              'auto detailing','won',
   'Repo bcns-client-l2detailz. Marked complete. Dropped Tailwind for its own gold palette.'),
  ('a0000000-0000-4000-8000-000000000004', 'Technology Associates',   null,           'won',
   'Repo bcns-client-technology-associates. Template styling, unmodified.'),
  ('a0000000-0000-4000-8000-000000000005', 'Wholesale Window Company',null,           'won',
   'Repo bcns-client-wwc. Template styling, unmodified.')
on conflict (id) do nothing;

insert into clients (account_id, slug, status)
values
  ('a0000000-0000-4000-8000-000000000001', 'coventry',              'active'),
  ('a0000000-0000-4000-8000-000000000002', 'delucas',               'active'),
  ('a0000000-0000-4000-8000-000000000003', 'l2detailz',             'active'),
  ('a0000000-0000-4000-8000-000000000004', 'technology-associates', 'active'),
  ('a0000000-0000-4000-8000-000000000005', 'wwc',                   'active')
on conflict (account_id) do nothing;

commit;
