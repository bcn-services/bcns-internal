-- ---------------------------------------------------------------------------
-- 0002_dev_fixtures.sql — clearly-synthetic fixture data, so every surface
-- added in items 1–12 renders with content instead of an empty state.
--
-- LOCAL SCRATCH DATABASES ONLY. Apply it through `scripts/seed-dev.mjs`, which
-- refuses any host that is not localhost / 127.0.0.1 / ::1 / a unix socket.
-- Nothing here is true. Every business is invented, every address is
-- @example.com or @example.org, every phone number is in the +1-555-01xx block
-- reserved for fiction, and every `agent_tokens.sealed` value is the literal
-- string NOT-A-REAL-TOKEN. If a row in this file ever shows up in production,
-- it is legible at a glance as fixture data and not as a fact.
--
-- WHAT IT DOES NOT DO. It never fills a value the lane records as unknown —
-- client monthly rates, `clients.domain`, `clients.droplet_host` for the four
-- real clients that lack them, and `accounts.assigned_to` / `consult_date` on
-- the imported roster are left exactly as they are. The synthetic rows below
-- carry their own values; they do not backfill anybody else's.
--
-- ROLE IS NOT SEEDED. `admin` vs `member` lives in the JWT's app_metadata, not
-- in this database (see 0004's note on why). Give a fixture profile a role with
-- `corepack pnpm provision-user`; this file can only seed the profile.
--
-- Re-runnable: every insert is ON CONFLICT DO NOTHING on a fixed id.
-- ---------------------------------------------------------------------------

begin;

-- -- people ------------------------------------------------------------------
-- profiles.id references auth.users, so the auth rows come first. On a real
-- local Supabase these are sign-in-less shells: enough for a foreign key and
-- for a name in a picker, not enough to log in as.
insert into auth.users (id, email) values
  ('f2000000-0000-4000-8000-000000000001', 'dev.fixture@example.com'),
  ('f2000000-0000-4000-8000-000000000002', 'sales.fixture@example.com'),
  ('f2000000-0000-4000-8000-000000000003', 'ops.fixture@example.com'),
  ('f2000000-0000-4000-8000-000000000004', 'unassigned.fixture@example.org')
on conflict (id) do nothing;

insert into profiles (id, email, display_name, active, job_function, last_briefed_at) values
  ('f2000000-0000-4000-8000-000000000001', 'dev.fixture@example.com',        'Fixture Dev (synthetic)',   true,  'developer', now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000002', 'sales.fixture@example.com',      'Fixture Sales (synthetic)', true,  'sales',     now() - interval '3 days'),
  ('f2000000-0000-4000-8000-000000000003', 'ops.fixture@example.com',        'Fixture Ops (synthetic)',   true,  'ops',       null),
  -- No job_function and inactive: the "skip me" case both the briefing job and
  -- the assignment pickers have to handle.
  ('f2000000-0000-4000-8000-000000000004', 'unassigned.fixture@example.org', 'Fixture Alum (synthetic)',  false, null,        null)
on conflict (id) do nothing;

-- -- agent seats -------------------------------------------------------------
-- One of each state the token panel can show: expired, expiring (inside the
-- 30-day warning window), ok, and — by omission — not connected.
-- `sealed` is not a token and could not be mistaken for one; it is not even
-- the right shape to decrypt.
insert into agent_tokens (profile_id, sealed, key_id, expires_at, last_used_at) values
  ('f2000000-0000-4000-8000-000000000001', 'v1.FIXTURE.NOT-A-REAL-TOKEN.NOT-A-REAL-TOKEN', 'dev-fixture-key', now() - interval '5 days',   now() - interval '6 days'),
  ('f2000000-0000-4000-8000-000000000002', 'v1.FIXTURE.NOT-A-REAL-TOKEN.NOT-A-REAL-TOKEN', 'dev-fixture-key', now() + interval '10 days',  now() - interval '2 hours'),
  ('f2000000-0000-4000-8000-000000000003', 'v1.FIXTURE.NOT-A-REAL-TOKEN.NOT-A-REAL-TOKEN', 'dev-fixture-key', now() + interval '300 days', null)
  -- profile ...0004 deliberately has no row: that is the `none` state.
on conflict (profile_id) do nothing;

-- -- leads -------------------------------------------------------------------
-- Eight invented businesses spread across the funnel and across all four
-- outreach lanes. Phones are +1-555-01xx (the fiction block); every website is
-- an example.com subdomain, which resolves nowhere.
insert into accounts (
  id, place_id, business_name, business_type, city, phone, website, has_website,
  rating, review_count, lead_score, score_reason, status, call_count,
  last_contact, contact_name, last_outcome, deal_value_cents, source_query,
  outreach_mode, notes
) values
  ('f0000000-0000-4000-8000-000000000001', 'FIXTURE_PLACE_01', 'Nowhere Plumbing Co (fixture)',   'plumbing',      'Springfield', '+1-555-0101', 'https://nowhere-plumbing.example.com', true,  4.6, 88,  82, 'Synthetic: strong reviews, dated site.',       'new',               0, null,                        null,               null,                              null,   'plumbers springfield', 'ai',          'FIXTURE ROW — invented business, not a real lead.'),
  ('f0000000-0000-4000-8000-000000000002', 'FIXTURE_PLACE_02', 'Placeholder Roofing (fixture)',   'roofing',       'Springfield', '+1-555-0102', 'https://placeholder-roofing.example.com', true, 4.1, 34,  61, 'Synthetic: mid reviews, has a site.',          'attempted',         2, current_date - 4,            'A. Placeholder',   'Left voicemail twice.',            null,   'roofers springfield',  'ai',          'FIXTURE ROW — invented business, not a real lead.'),
  ('f0000000-0000-4000-8000-000000000003', 'FIXTURE_PLACE_03', 'Example Auto Detail (fixture)',   'auto detailing','Shelbyville', '+1-555-0103', null,                                   false, 4.9, 12,  91, 'Synthetic: no website at all.',                'reached',           3, current_date - 1,            'B. Example',       'Spoke to the owner; wants a callback.', null, 'detailers shelbyville','human',      'FIXTURE ROW — flipped to the human lane on purpose.'),
  ('f0000000-0000-4000-8000-000000000004', 'FIXTURE_PLACE_04', 'Sample Landscaping (fixture)',    'landscaping',   'Shelbyville', '+1-555-0104', 'https://sample-landscaping.example.com', true, 3.8, 55,  44, 'Synthetic: thin reviews.',                     'consult_scheduled', 4, current_date - 2,            'C. Sample',        'Consult booked.',                  null,   'landscapers shelbyville','paused',   'FIXTURE ROW — outreach paused, lane preserved.'),
  ('f0000000-0000-4000-8000-000000000005', 'FIXTURE_PLACE_05', 'Testfield Electric (fixture)',    'electrician',   'Ogdenville',  '+1-555-0105', 'https://testfield-electric.example.com', true, 4.3, 21,  70, 'Synthetic: three touches, silence.',           'attempted',         3, current_date - 21,           'D. Testfield',     'No reply after three emails.',     null,   'electricians ogdenville','no_response','FIXTURE ROW — exhausted the three permitted touches.'),
  ('f0000000-0000-4000-8000-000000000006', 'FIXTURE_PLACE_06', 'Demo Bakery (fixture)',           'bakery',        'Ogdenville',  '+1-555-0106', 'https://demo-bakery.example.com',       true,  4.7, 140, 55, 'Synthetic: consult happened, no decision.',    'consult_done',      5, current_date - 9,            'E. Demo',          'Consult done; thinking it over.',   null,  'bakeries ogdenville',  'human',       'FIXTURE ROW — invented business, not a real lead.'),
  ('f0000000-0000-4000-8000-000000000007', 'FIXTURE_PLACE_07', 'Fixture Window Works (fixture)',  'windows',       'North Haverbrook', '+1-555-0107', 'https://fixture-windows.example.com', true, 4.4, 63, 78, 'Synthetic: signed, for the clients surface.', 'won',               6, current_date - 30,           'F. Fixture',       'Signed.',                          24000,  'window installers',    'human',       'FIXTURE ROW — the synthetic client below hangs off this row.'),
  ('f0000000-0000-4000-8000-000000000008', 'FIXTURE_PLACE_08', 'Vanished Catering (fixture)',     'catering',      'North Haverbrook', '+1-555-0108', null,                                false, 3.2, 4,   18, 'Synthetic: dead, for the terminal-stage tiles.', 'lost',            1, current_date - 60,           'G. Vanished',      'Went with a cousin.',              null,   'caterers',             'paused',      'FIXTURE ROW — terminal stage, kept so the funnel is not all-open.')
on conflict (id) do nothing;

-- One synthetic client, so /clients shows a launched row alongside the real
-- roster. Its domain and droplet_host are invented AND labelled as such —
-- unlike the four real clients, whose blanks stay blank.
insert into clients (id, account_id, slug, status, monthly_rate_cents, domain, repo, droplet_host, droplet_port, launch_date, notes) values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000007', 'fixture-window-works', 'active', 9900,
   'fixture-window-works.example.com', 'example-org/bcns-client-fixture', 'fixture-host.example.com', 3100, current_date - 25,
   'FIXTURE ROW — invented client. Domain and host are example.com placeholders.')
on conflict (id) do nothing;

-- -- the timeline ------------------------------------------------------------
-- Both halves of account_activity: the five human kinds and the three agent
-- kinds. Seeded as the superuser, so 0010's authorship trigger and 0016's
-- pause trigger both correctly stay out of the way (they key on
-- current_user = 'authenticated').
insert into account_activity (id, account_id, occurred_at, kind, outcome, note, actor_email) values
  ('f4000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', now() - interval '4 days',  'call',          'voicemail',   'Rang out, left a message.',                       'sales.fixture@example.com'),
  ('f4000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003', now() - interval '1 day',   'call',          'spoke',       'Owner picked up; asked for a callback Thursday.', 'sales.fixture@example.com'),
  ('f4000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', now() - interval '20 hours','note',          null,          'Fixture note: no website, so the demo lands hard.','sales.fixture@example.com'),
  ('f4000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000004', now() - interval '2 days',  'meeting',       'booked',      'Consult on the calendar.',                        'ops.fixture@example.com'),
  ('f4000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000006', now() - interval '9 days',  'status_change', 'consult_done','Moved after the consult.',                        'sales.fixture@example.com'),
  ('f4000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-000000000007', now() - interval '30 days', 'email',         'replied',     'Sent the proposal; they replied same day.',       'sales.fixture@example.com'),
  ('f4000000-0000-4000-8000-000000000007', 'f0000000-0000-4000-8000-000000000001', now() - interval '6 days',  'ai_email_sent', 'sent',        'Touch 1 delivered.',                              'outreach-bot@example.com'),
  ('f4000000-0000-4000-8000-000000000008', 'f0000000-0000-4000-8000-000000000001', now() - interval '5 days',  'ai_email_reply','replied',     'Fixture reply: "who is this?"',                   'outreach-bot@example.com'),
  ('f4000000-0000-4000-8000-000000000009', 'f0000000-0000-4000-8000-000000000005', now() - interval '2 days',  'agent_run',     'no_action',   'Swept, three touches already spent, did nothing.','outreach-bot@example.com')
on conflict (id) do nothing;

-- -- outreach drafts ---------------------------------------------------------
-- More than one touch number, including a lead that has burned all three.
insert into outreach_drafts (id, account_id, touch_number, subject, body, business_description, notes, site_url, source_job) values
  ('f5000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 1, 'A faster site for Nowhere Plumbing (fixture)', 'FIXTURE DRAFT. Never sent. Opening touch.',   'Synthetic plumbing shop, one-page site.', 'Fixture notes.', 'https://nowhere-plumbing.example.com', 'outreach_sweep'),
  ('f5000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 2, 'Following up (fixture)',                       'FIXTURE DRAFT. Never sent. Second touch.',    null,                                      null,             null,                                   'outreach_sweep'),
  ('f5000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005', 1, 'Booking work online (fixture)',                'FIXTURE DRAFT. Never sent.',                  'Synthetic electrician.',                  null,             'https://testfield-electric.example.com','outreach_sweep'),
  ('f5000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000005', 2, 'One more thought (fixture)',                   'FIXTURE DRAFT. Never sent.',                  null,                                      null,             null,                                   'outreach_sweep'),
  ('f5000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000005', 3, 'Last note from me (fixture)',                  'FIXTURE DRAFT. Never sent. Third and final.', null,                                      'Third touch spent; lane goes no_response.', null,          'outreach_sweep')
on conflict (id) do nothing;

-- -- where the prospector is pointed -----------------------------------------
insert into lead_targets (id, trade, town, active, created_by) values
  ('f6000000-0000-4000-8000-000000000001', 'plumbing',       'Springfield',       true,  'f2000000-0000-4000-8000-000000000002'),
  ('f6000000-0000-4000-8000-000000000002', 'roofing',        'Springfield',       true,  'f2000000-0000-4000-8000-000000000002'),
  ('f6000000-0000-4000-8000-000000000003', 'auto detailing', 'Shelbyville',       true,  null),
  ('f6000000-0000-4000-8000-000000000004', 'catering',       'North Haverbrook',  false, 'f2000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

-- -- job history -------------------------------------------------------------
-- Every tone the admin panel can render: ok, attention (item 12's split),
-- failed, error, cancelled, and a still-running row with a null finished_at.
insert into job_runs (id, job, started_at, finished_at, status, actor, log, window_key) values
  ('f7000000-0000-4000-8000-000000000001', 'site_health',        now() - interval '2 hours', now() - interval '2 hours' + interval '9 seconds',  'ok',        'cron:site_health',        'Fixture: 5 sites checked, all 200.',                        'site_health:' || (current_date)::text),
  ('f7000000-0000-4000-8000-000000000002', 'site_health',        now() - interval '1 day',   now() - interval '1 day' + interval '11 seconds',   'attention', 'cron:site_health',        'Fixture: fixture-window-works.example.com returned 503.',   'site_health:' || (current_date - 1)::text),
  ('f7000000-0000-4000-8000-000000000003', 'credential_expiry',  now() - interval '2 days',  now() - interval '2 days' + interval '3 seconds',   'attention', 'cron:credential_expiry',  'Fixture: 1 seat expires in 10 days.',                       'credential_expiry:' || (current_date - 2)::text),
  ('f7000000-0000-4000-8000-000000000004', 'quiet_clients',      now() - interval '3 days',  now() - interval '3 days' + interval '2 seconds',   'failed',    'cron:quiet_clients',      'Fixture: threw before it finished. Stack elided.',          'quiet_clients:' || (current_date - 3)::text),
  ('f7000000-0000-4000-8000-000000000005', 'leads',              now() - interval '4 days',  now() - interval '4 days',                          'error',     'sales.fixture@example.com','Fixture: refused — no agent seat enrolled for this person.', null),
  ('f7000000-0000-4000-8000-000000000006', 'outreach_sweep',     now() - interval '5 days',  now() - interval '5 days' + interval '1 second',    'cancelled', 'ops.fixture@example.com', 'Fixture: stopped by the person who started it.',            null),
  -- finished_at null on purpose: this is what a stuck job looks like.
  ('f7000000-0000-4000-8000-000000000007', 'outreach_sweep',     now() - interval '20 minutes', null,                                            'running',   'cron:outreach_sweep',     'Fixture: still going, or died without writing back.',       'outreach_sweep:' || (current_date)::text)
on conflict (id) do nothing;

-- -- private mail ------------------------------------------------------------
-- Read and unread, across more than one profile, so the sidebar badge is
-- non-zero and the read/unread split is visible rather than theoretical.
insert into inbox_items (id, profile_id, kind, title, body, source_job, account_id, client_id, read_at) values
  ('f8000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000002', 'lead_reply',        'Example Auto Detail (fixture) replied', 'Fixture notice. The lead answered touch 1; the lane moved to human.', 'outreach_sweep',    'f0000000-0000-4000-8000-000000000003', null,                                   null),
  ('f8000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 'lead_went_quiet',   'Testfield Electric (fixture) went quiet','Fixture notice. Three touches spent, no reply.',                     'outreach_sweep',    'f0000000-0000-4000-8000-000000000005', null,                                   null),
  ('f8000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000002', 'task_assigned',     'You were assigned a task (fixture)',    'Fixture notice. Chase the Shelbyville consult.',                     null,                null,                                   null,                                   now() - interval '4 hours'),
  ('f8000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'job_run_attention', 'site_health needs attention (fixture)',  'Fixture notice. A hosted site returned 503 on the last sweep.',      'site_health',       null,                                   'f1000000-0000-4000-8000-000000000001', null),
  ('f8000000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-000000000001', 'job_run_failed',    'quiet_clients failed (fixture)',        'Fixture notice. The run threw before it finished.',                  'quiet_clients',     null,                                   null,                                   now() - interval '2 days'),
  ('f8000000-0000-4000-8000-000000000006', 'f2000000-0000-4000-8000-000000000003', 'credential_expiry', 'A seat expires in 10 days (fixture)',   'Fixture notice. Re-enrol before jobs stop that day.',                'credential_expiry', null,                                   null,                                   null)
on conflict (id) do nothing;

-- -- work -------------------------------------------------------------------
insert into tasks (id, account_id, title, details, assigned_to, status, due_date, created_by) values
  ('f3000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000003', 'Call Example Auto Detail back (fixture)', 'Thursday, per the last call.',      'f2000000-0000-4000-8000-000000000002', 'todo',      current_date + 1, 'f2000000-0000-4000-8000-000000000002'),
  ('f3000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000007', 'Ship the fixture client homepage',        'Fixture task on the synthetic client.','f2000000-0000-4000-8000-000000000001', 'doing',    current_date + 5, 'f2000000-0000-4000-8000-000000000001'),
  -- Overdue and unassigned: the two cases the morning board calls out.
  ('f3000000-0000-4000-8000-000000000003', null,                                   'Write the fixture runbook',               'Internal bcns work, nobody on it.',  null,                                   'todo',      current_date - 3, 'f2000000-0000-4000-8000-000000000001'),
  ('f3000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000004', 'Prep the Sample Landscaping consult',     'Fixture task.',                      'f2000000-0000-4000-8000-000000000003', 'done',      current_date - 2, 'f2000000-0000-4000-8000-000000000002'),
  ('f3000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000008', 'Chase Vanished Catering (fixture)',       'Dropped when the lead went cold.',   'f2000000-0000-4000-8000-000000000002', 'cancelled', current_date - 20,'f2000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

commit;
