# Project Standards — bcns-internal

Project-specific conventions observed in this repo. Global standards live in
`~/.claude/skills/dev-team/review-standards.md` and are not repeated here.

## Migrations
- **One transaction per file**: every `supabase/migrations/NNNN_*.sql` opens with `begin;` and ends with `commit;`, because the replay harness and the Supabase CLI apply with `psql -f` and no `--single-transaction`. See 0009, 0010, 0015.
- **Every up migration ships a `.down.sql`**: and a down that must narrow a CHECK moves offending rows to the *safer* value first (0015 moves `no_response` → `paused`, never → `ai`).
- **`security definer` functions pin `set search_path = ''`**: and schema-qualify every reference. See 0002, 0010, 0015.

## Jobs
- **A job returns findings; `runJob` derives the status.** A job never writes its own `job_runs.status`, and a finding always means `failed`.
- **Every external dependency of a job is an injected function type** (`SiteFetcher`, `SiteReader`, `Evaluator`, `CommitReader`) with a stated no-op default, so no test can open a socket.
- **Idempotency is a unique index, not a timestamp comparison**: the window claim is one INSERT that either wins or raises 23505.

## Enums shared between TypeScript and Postgres
- **One TS list per database CHECK, imported everywhere**: a CHECK's value set is declared once as an `as const` array and every validator, JSON-schema `enum`, and UI label map derives from it. Duplicating the list (`OUTREACH_MODES` in `lib/agent/verbs/leads_write.ts` vs `LANE_MODES`/`MANUAL_LANE_MODES` in `lib/outreach.ts`) is how two readers end up disagreeing.

## Untrusted content
- **Fetched page text is fenced at the source**: `read_site` applies `fenceUntrusted` inside its own `ok(...)` payload, so every consumer gets fenced text without remembering to fence it. Anything else interpolated into the same prompt must be fenced by the prompt builder.
