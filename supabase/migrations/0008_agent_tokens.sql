-- ---------------------------------------------------------------------------
-- 0008_agent_tokens — one Claude Code OAuth token per employee.
--
-- WHY PER-EMPLOYEE. The runner spawns `claude -p` on the droplet. A single
-- shared token would make every run in the company look like one identity: one
-- person's rate limit, one person's usage bill, one person's name on whatever
-- the agent wrote. Each employee enrolls their own seat with
-- `claude setup-token` and the runner injects that token, and only that token,
-- into their own spawns.
--
-- WHY THERE ARE NO POLICIES. RLS is enabled and this table has zero policies,
-- which denies every read and every write to `authenticated` — including the
-- owner's. That is deliberate and is the whole security model of the table: a
-- token is a bearer credential, so the browser that submitted it should never
-- be able to read it back, not even its own. Only the service role reaches
-- these rows, from the server, and the only value it ever hands back out is a
-- decrypted token going straight into a child process's environment.
--
-- A column grant could not have achieved this. Admin and member are both
-- `authenticated` to Postgres, so no grant separates them; absence of policy
-- is the one mechanism that denies both.
--
-- The ciphertext is AES-256-GCM under AGENT_TOKEN_KEY, which lives in the
-- droplet's environment and never in this database. A dump of this table
-- without that key is inert. See lib/agent/secrets.ts for the envelope format.
-- ---------------------------------------------------------------------------

create table agent_tokens (
  -- The employee this token belongs to. Same id as the auth user (profiles.id
  -- IS auth.users.id), so the runner needs no join to answer "whose token is
  -- this". Cascade: deleting the auth user destroys the credential with it,
  -- which is what makes offboarding a single action.
  profile_id  uuid primary key references profiles (id) on delete cascade,

  -- The sealed token: `v1.<iv>.<tag>.<ciphertext>`, all base64url. Opaque to
  -- SQL on purpose — nothing in the database interprets it.
  sealed      text not null,

  -- Which key sealed it. A key rotation cannot decrypt old rows, so this is
  -- how a run tells "wrong key, re-enroll" apart from "corrupt data", and how
  -- a future rotation finds the rows it still has to re-seal.
  key_id      text not null,

  -- `claude setup-token` issues a one-year token and refresh behavior is
  -- undocumented. Recorded so the app can warn ahead of expiry rather than
  -- failing silently next August. It is a claim by the enroller, not a
  -- verified fact — Anthropic is the authority, and nothing here checks it.
  expires_at  timestamptz not null,

  -- Observability for the admin page: who has enrolled, and whose token is
  -- actually being used. Written on every successful spawn.
  last_used_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger agent_tokens_set_updated_at
  before update on agent_tokens
  for each row execute function set_updated_at();

alter table agent_tokens enable row level security;
