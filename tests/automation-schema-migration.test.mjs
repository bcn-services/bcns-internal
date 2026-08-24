/**
 * automation-schema-migration.test.mjs — 0009 adds the automation schema.
 *
 * Two properties carry the whole migration and are the reason for this file:
 *
 *   1. The widened account_activity.kind CHECK is a SUPERSET. A later edit that
 *      rewrites the list is one typo away from dropping 'status_change' and
 *      silently breaking every status write in the app, so all eight values are
 *      asserted individually, plus a rejection.
 *
 *   2. inbox_items is private FROM ADMIN TOO. Every other table in this schema
 *      has an `is_admin()` full-access policy, so "add the admin policy like
 *      everywhere else" is the natural wrong move. It is asserted as a denial.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";

if (!toolsPresent) {
  test("SKIPPED: PG tooling absent at /opt/homebrew/bin", () => {
    assert.fail("initdb/pg_ctl/psql not found — install postgresql to run migration tests");
  });
}

const MIGRATIONS = [
  "0001_core_schema.sql",
  "0002_rls_policies.sql",
  "0003_project_manual.sql",
  "0004_profiles.sql",
  "0005_tasks.sql",
  "0006_seed_clients.sql",
  "0007_own_tasks_only.sql",
  "0008_agent_tokens.sql",
  "0009_automation_schema.sql",
];

const NATE = "dddddddd-0000-4000-8000-000000000001";
const BRANDON = "dddddddd-0000-4000-8000-000000000002";
const ACCOUNT = "dddddddd-0000-4000-8000-0000000000a1";

// Claims carry `sub`, which is what auth.uid() reads — the shared CLAIMS
// fixtures have no sub and would make every owner comparison null.
const admin = { sub: NATE, app_metadata: { role: "admin" }, email: "nate@bcn-services.com" };
const brandon = { sub: BRANDON, app_metadata: { role: "member" }, email: "brandon@bcn-services.com" };

const HUMAN_KINDS = ["call", "email", "meeting", "note", "status_change"];
const AGENT_KINDS = ["ai_email_sent", "ai_email_reply", "agent_run"];

describe("0009 automation schema", () => {
  let pg;
  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    pg.run(`insert into auth.users (id, email) values
      ('${NATE}','nate@bcn-services.com'), ('${BRANDON}','brandon@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values
      ('${NATE}','nate@bcn-services.com','Nate'),
      ('${BRANDON}','brandon@bcn-services.com','Brandon')`);
    pg.run(`insert into accounts (id, business_name, city, status)
      values ('${ACCOUNT}', 'Automation Test Co', 'Rye', 'new')`);
  });
  after(() => pg?.stop());

  // -- accounts.outreach_mode ------------------------------------------------

  test("outreach_mode defaults to 'ai' when omitted", () => {
    pg.run(`insert into accounts (id, business_name, status)
            values ('dddddddd-0000-4000-8000-0000000000a2','Default Co','new')`);
    assert.equal(
      pg.run(`select outreach_mode from accounts where id='dddddddd-0000-4000-8000-0000000000a2'`),
      "ai",
    );
  });

  for (const mode of ["ai", "human", "paused"]) {
    test(`outreach_mode accepts '${mode}'`, () => {
      const r = pg.tryRun(`update accounts set outreach_mode='${mode}' where id='${ACCOUNT}'`);
      assert.equal(r.ok, true, r.error);
    });
  }

  test("outreach_mode rejects an unknown mode", () => {
    const r = pg.tryRun(`insert into accounts (business_name, status, outreach_mode)
                         values ('Bad Co','new','invalid')`);
    assert.equal(r.ok, false);
    assert.match(r.error, /outreach_mode/i);
  });

  // -- account_activity.kind ------------------------------------------------

  for (const kind of [...HUMAN_KINDS, ...AGENT_KINDS]) {
    test(`account_activity accepts kind '${kind}'`, () => {
      // The five human kinds are asserted alongside the three new ones on
      // purpose: this migration must WIDEN the constraint, never replace it.
      const r = pg.tryRun(
        `insert into account_activity (account_id, kind) values ('${ACCOUNT}','${kind}')`);
      assert.equal(r.ok, true, r.error);
    });
  }

  test("account_activity still rejects an unknown kind", () => {
    const r = pg.tryRun(
      `insert into account_activity (account_id, kind) values ('${ACCOUNT}','nonsense')`);
    assert.equal(r.ok, false);
    assert.match(r.error, /kind/i);
  });

  // The widened CHECK meets 0002's staff INSERT policy, so the policy is
  // narrowed in 0009: agent kinds are service_role-only, or a member could
  // forge an `ai_email_sent` row, or pre-write the `agent_run` idempotency
  // marker for an account and quietly suppress the agent's next run on it.
  for (const kind of AGENT_KINDS) {
    test(`a member cannot insert kind '${kind}'`, () => {
      const r = pg.runClaims(brandon,
        `insert into account_activity (account_id, kind) values ('${ACCOUNT}','${kind}')`);
      assert.equal(r.ok, false);
      assert.match(r.error, /row-level security/i);
    });
  }

  test("a member can still insert a human kind", () => {
    const r = pg.runClaims(brandon,
      `insert into account_activity (account_id, kind) values ('${ACCOUNT}','call')`);
    assert.equal(r.ok, true, r.error);
  });

  test("an admin can still insert an agent kind, via account_activity_admin_all", () => {
    // Deliberate, and asserted so it cannot change silently: 0002's admin FOR
    // ALL policy is permissive and OR-combines with the narrowed staff INSERT.
    // The finding this closes is a NON-admin forging the trail; an admin who
    // can already delete any row is not the threat being modelled.
    const r = pg.runClaims(admin,
      `insert into account_activity (account_id, kind) values ('${ACCOUNT}','agent_run')`);
    assert.equal(r.ok, true, r.error);
  });

  test("service_role can insert an agent kind", () => {
    // pg.run() is the superuser connection, which bypasses RLS exactly as
    // Supabase's service_role does — the jobs' own path.
    const r = pg.tryRun(
      `insert into account_activity (account_id, kind) values ('${ACCOUNT}','agent_run')`);
    assert.equal(r.ok, true, r.error);
  });

  test("an unprovisioned claim cannot insert any activity", () => {
    const r = pg.runClaims({ sub: BRANDON, app_metadata: {} },
      `insert into account_activity (account_id, kind) values ('${ACCOUNT}','call')`);
    assert.equal(r.ok, false);
    assert.match(r.error, /row-level security/i);
  });

  // -- profiles -------------------------------------------------------------

  test("job_function is nullable and last_briefed_at starts null", () => {
    assert.equal(
      pg.run(`select job_function is null and last_briefed_at is null
              from profiles where id='${NATE}'`),
      "t",
    );
  });

  test("job_function rejects a value outside developer/sales/ops", () => {
    const r = pg.tryRun(`update profiles set job_function='wizard' where id='${NATE}'`);
    assert.equal(r.ok, false);
    assert.match(r.error, /job_function/i);
  });

  test("job_function accepts developer, sales and ops", () => {
    for (const f of ["developer", "sales", "ops"]) {
      const r = pg.tryRun(`update profiles set job_function='${f}' where id='${NATE}'`);
      assert.equal(r.ok, true, r.error);
    }
  });

  // -- inbox_items privacy --------------------------------------------------

  describe("inbox_items", () => {
    before(() => {
      pg.run(`insert into inbox_items (profile_id, kind, title, body, source_job)
              values ('${BRANDON}','lead_cold','Brandon private','body','brief')`);
      pg.run(`insert into inbox_items (profile_id, kind, title, source_job)
              values ('${NATE}','lead_cold','Nate private','brief')`);
    });

    test("the owner sees only their own items", () => {
      const r = pg.runClaims(brandon, `select title from inbox_items`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "Brandon private");
    });

    test("another profile's items return zero rows", () => {
      const r = pg.runClaims(brandon,
        `select count(*) from inbox_items where profile_id='${NATE}'`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0");
    });

    test("an ADMIN cannot read another profile's inbox", () => {
      // The guardrail of this table. Admin is exempt everywhere else in the
      // schema and must not be exempt here.
      const r = pg.runClaims(admin,
        `select count(*) from inbox_items where profile_id='${BRANDON}'`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0");
    });

    test("the owner can mark their own item read", () => {
      const r = pg.runClaims(brandon,
        `update inbox_items set read_at=now() where profile_id='${BRANDON}';
         select count(*) from inbox_items where read_at is not null`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "1");
    });

    test("an update cannot move an item into someone else's inbox", () => {
      // WITH CHECK. Without it, an owner could plant a notice on a colleague.
      const r = pg.runClaims(brandon,
        `update inbox_items set profile_id='${NATE}' where profile_id='${BRANDON}'`);
      assert.equal(r.ok, false);
      assert.match(r.error, /row-level security/i);
    });

    test("nobody interactive can insert an inbox item", () => {
      for (const who of [brandon, admin]) {
        const r = pg.runClaims(who,
          `insert into inbox_items (profile_id, kind, title)
           values ('${who.sub}','x','planted')`);
        assert.equal(r.ok, false);
        assert.match(r.error, /row-level security/i);
      }
    });

    test("deleting the auth user removes their inbox", () => {
      pg.run(`insert into auth.users (id, email)
              values ('dddddddd-0000-4000-8000-000000000003','gone@bcn-services.com')`);
      pg.run(`insert into profiles (id, email, display_name)
              values ('dddddddd-0000-4000-8000-000000000003','gone@bcn-services.com','Gone')`);
      pg.run(`insert into inbox_items (profile_id, kind, title)
              values ('dddddddd-0000-4000-8000-000000000003','x','bye')`);
      pg.run(`delete from auth.users where id='dddddddd-0000-4000-8000-000000000003'`);
      assert.equal(
        pg.run(`select count(*) from inbox_items
                where profile_id='dddddddd-0000-4000-8000-000000000003'`),
        "0",
      );
    });
  });

  // -- lead_targets / job_runs: admin-write, staff-read ----------------------

  describe("lead_targets and job_runs", () => {
    before(() => {
      pg.run(`insert into lead_targets (trade, town, created_by)
              values ('roofing','Rye','${NATE}')`);
      pg.run(`insert into job_runs (job, status, actor) values ('brief','ok','cron')`);
    });

    test("lead_targets.active defaults true", () => {
      assert.equal(pg.run(`select active from lead_targets where trade='roofing'`), "t");
    });

    test("job_runs.finished_at starts null", () => {
      assert.equal(pg.run(`select finished_at is null from job_runs where job='brief'`), "t");
    });

    for (const t of ["lead_targets", "job_runs"]) {
      test(`a member can read ${t}`, () => {
        const r = pg.runClaims(brandon, `select count(*) from ${t}`);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.out, "1");
      });

      test(`an admin can write ${t}`, () => {
        const sql = t === "lead_targets"
          ? `insert into lead_targets (trade, town) values ('paving','Harrison')`
          : `insert into job_runs (job, status) values ('prospect','ok')`;
        const r = pg.runClaims(admin, sql);
        assert.equal(r.ok, true, r.error);
      });

      test(`a member cannot write ${t}`, () => {
        const sql = t === "lead_targets"
          ? `insert into lead_targets (trade, town) values ('siding','Mamaroneck')`
          : `insert into job_runs (job, status) values ('sneaky','ok')`;
        const r = pg.runClaims(brandon, sql);
        assert.equal(r.ok, false);
        assert.match(r.error, /row-level security/i);
      });
    }
  });

  // -- structural -----------------------------------------------------------

  for (const t of ["inbox_items", "lead_targets", "job_runs"]) {
    test(`row level security is on for ${t}`, () => {
      assert.equal(pg.run(`select relrowsecurity from pg_class where relname='${t}'`), "t");
    });
  }

  for (const [idx, tbl] of Object.entries({
    inbox_items_account_idx: "inbox_items",
    inbox_items_client_idx: "inbox_items",
    lead_targets_created_by_idx: "lead_targets",
    job_runs_unfinished_idx: "job_runs",
  })) {
    test(`${idx} exists on ${tbl}`, () => {
      // Matched by name, not by count: a renamed or re-columned index must fail
      // here rather than pass because the total happened to stay the same.
      assert.equal(
        pg.run(`select count(*) from pg_indexes
                where tablename='${tbl}' and indexname='${idx}'`),
        "1",
      );
    });
  }

  test("inbox_items has no admin-override policy", () => {
    // Asserted by name, not by count: a count check would pass if someone
    // swapped an owner policy for an admin one.
    const names = pg.run(
      `select polname from pg_policy where polrelid='inbox_items'::regclass order by polname`);
    assert.equal(names, "inbox_items_own_select\ninbox_items_own_update");
  });

  test("the down migration reverses cleanly", () => {
    const r = pg.tryRunFile("0009_automation_schema.down.sql");
    assert.equal(r.ok, true, r.error);
    assert.equal(pg.run(`select count(*) from pg_class where relname='inbox_items'`), "0");
    assert.equal(
      pg.run(`select count(*) from information_schema.columns
              where table_name='accounts' and column_name='outreach_mode'`),
      "0",
    );
    // And the narrowed CHECK is back: agent kinds rejected, human kinds fine.
    assert.equal(
      pg.tryRun(`insert into account_activity (account_id, kind)
                 values ('${ACCOUNT}','agent_run')`).ok,
      false,
    );
    assert.equal(
      pg.tryRun(`insert into account_activity (account_id, kind)
                 values ('${ACCOUNT}','status_change')`).ok,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Independent verification (QA). The tests above were written by the author of
// the migration; these check the guardrails his own tests were free to assume.
// ---------------------------------------------------------------------------

/** Keywords that take a parenthesised list and so look like a call to the sweep. */
const SQL_KEYWORDS = new Set(["in", "not", "and", "or", "any", "all", "array", "exists", "values"]);

/** Every `create policy ... ;` statement in 0009, comments stripped. */
function policyStatements() {
  const src = readFileSync(
    fileURLToPath(new URL("../supabase/migrations/0009_automation_schema.sql", import.meta.url)),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  return [...src.matchAll(/create\s+policy[\s\S]*?;/gi)].map((m) => m[0]);
}

/**
 * Names called unqualified inside a policy's using/with check expressions.
 * Everything after `using`/`with check` is expression territory; a call is
 * `name(`, qualified only when preceded by `schema.`. SQL keywords that take a
 * parenthesised list (`kind not in (...)`) are not calls.
 */
function unqualifiedCalls(stmt) {
  const found = [];
  for (const [, expr] of stmt.matchAll(/\b(?:using|with\s+check)\s*(\([\s\S]*?\))(?=\s*(?:using|with\s+check|;))/gi)) {
    for (const m of expr.matchAll(/(\.)?\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
      if (m[1]) continue;
      if (SQL_KEYWORDS.has(m[2].toLowerCase())) continue;
      found.push(m[2]);
    }
  }
  return found;
}

describe("0009 guardrails — independent QA", { skip: !toolsPresent && "no local Postgres" }, () => {
  test("no policy expression contains an unqualified function call", () => {
    const stmts = policyStatements();
    assert.equal(stmts.length, 7, `expected 7 policies in 0009, found ${stmts.length}`);
    for (const s of stmts) {
      assert.deepEqual(unqualifiedCalls(s), [],
        `unqualified call in policy: ${s.split("\n")[0]}`);
    }
  });

  test("the sweep still catches an unqualified call — mutation check", () => {
    // The keyword exemption loosened this check; prove it exempts keywords ONLY.
    const real = policyStatements().find((s) => /account_activity_staff_insert/i.test(s));
    assert.ok(real, "staff-insert policy not found in 0009");
    assert.deepEqual(unqualifiedCalls(real), []);

    // Mutate the one thing the exemption sits next to: unqualify is_staff().
    const mutated = real.replace("public.is_staff()", "is_staff()");
    assert.notEqual(mutated, real, "mutation did not apply");
    assert.deepEqual(unqualifiedCalls(mutated), ["is_staff"],
      "the sweep no longer catches an unqualified is_staff() next to `kind not in (...)`");

    // And the other two callees, in the policies that carry them.
    for (const [q, u] of [["public.is_admin()", "is_admin()"], ["auth.uid()", "uid()"]]) {
      const s = policyStatements().find((p) => p.includes(q));
      assert.ok(s, `no policy calls ${q}`);
      assert.ok(unqualifiedCalls(s.replaceAll(q, u)).length > 0,
        `the sweep misses an unqualified ${u}`);
    }

    // A keyword-shaped mutation must stay exempt (no false positive).
    assert.deepEqual(
      unqualifiedCalls(`create policy p on t for insert to authenticated
        with check (public.is_staff() and kind not in ('a','b') and x = any (array['c']));`),
      [],
    );
  });

  test("every 0009 policy call resolves under an empty search_path", () => {
    // The behavioral half of the guardrail: if a reference were unqualified,
    // this evaluates to an error rather than a boolean.
    const h = startClusterWithMigrations(MIGRATIONS);
    try {
      for (const call of ["public.is_admin()", "public.is_staff()", "auth.uid()"]) {
        const r = h.tryRun(`set search_path = ''; select ${call} is not distinct from ${call}`);
        assert.equal(r.ok, true, `${call} failed with empty search_path: ${r.error}`);
      }
    } finally {
      h.stop();
    }
  });

  test("0009 is purely additive — no column dropped, retyped, or made stricter", () => {
    const SNAP = `select string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable, E'\\n' order by table_name, column_name)
                  from information_schema.columns where table_schema='public'`;
    const h = startClusterWithMigrations(MIGRATIONS.slice(0, 8));
    try {
      const before = h.run(SNAP).split("\n").filter(Boolean);
      h.run(`insert into accounts (id, business_name, city, status)
             values ('${ACCOUNT}','Pre-0009 Co','Rye','new')`);
      for (const kind of HUMAN_KINDS) {
        h.run(`insert into account_activity (account_id, kind) values ('${ACCOUNT}','${kind}')`);
      }
      const rowsBefore = h.run(`select count(*) from account_activity`);

      h.runFile("0009_automation_schema.sql");

      const after = new Set(h.run(SNAP).split("\n").filter(Boolean));
      const lost = before.filter((c) => !after.has(c));
      assert.deepEqual(lost, [], `0009 dropped or changed existing columns: ${lost.join(", ")}`);
      assert.equal(h.run(`select count(*) from account_activity`), rowsBefore,
        "0009 deleted existing account_activity rows");
      // Pre-existing rows survive the CHECK swap with their values intact.
      assert.equal(
        h.run(`select count(distinct kind) from account_activity where account_id='${ACCOUNT}'`),
        String(HUMAN_KINDS.length),
      );
    } finally {
      h.stop();
    }
  });

  test("inbox_items privacy holds against every non-owner claim shape", () => {
    const h = startClusterWithMigrations(MIGRATIONS);
    try {
      h.run(`insert into auth.users (id, email) values
        ('${NATE}','nate@bcn-services.com'), ('${BRANDON}','brandon@bcn-services.com')`);
      h.run(`insert into profiles (id, email, display_name) values
        ('${NATE}','nate@bcn-services.com','Nate'), ('${BRANDON}','brandon@bcn-services.com','Brandon')`);
      h.run(`insert into inbox_items (profile_id, kind, title) values ('${NATE}','x','Nate only')`);

      const nateRow = () => h.run(`select title from inbox_items where profile_id='${NATE}'`);
      assert.equal(nateRow(), "Nate only");

      // SELECT: admin, a member, a role-less invite and a tampered claim all see nothing.
      // Every claim shape below is BRANDON — a different person from the owner.
      // Only the role varies, so what is under test is the role, not the subject.
      for (const [who, claims] of Object.entries({
        admin: { sub: BRANDON, app_metadata: { role: "admin" } },
        member: brandon,
        noRole: { sub: BRANDON, app_metadata: {} },
        fakeAdmin: { sub: BRANDON, user_metadata: { role: "admin" } },
      })) {
        const r = h.runClaims(claims, `select count(*) from inbox_items where profile_id='${NATE}'`);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.out, "0", `${who} could read another profile's inbox`);
      }

      // UPDATE and DELETE: a non-owner must change nothing, silently or otherwise.
      for (const claims of [{ sub: BRANDON, app_metadata: { role: "admin" } }, brandon]) {
        h.runClaims(claims, `update inbox_items set title='tampered' where profile_id='${NATE}'`);
        h.runClaims(claims, `delete from inbox_items where profile_id='${NATE}'`);
      }
      assert.equal(nateRow(), "Nate only", "a non-owner mutated another profile's inbox item");

      // Even the owner has no DELETE policy — only jobs (service_role) remove mail.
      h.runClaims(admin, `delete from inbox_items where profile_id='${NATE}'`);
      assert.equal(nateRow(), "Nate only", "the owner deleted an inbox item with no delete policy");
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Re-verification (QA), after the reviewer's findings were applied.
// ---------------------------------------------------------------------------
describe("0009 re-verification — independent QA", { skip: !toolsPresent && "no local Postgres" }, () => {
  let h;
  before(() => {
    h = startClusterWithMigrations(MIGRATIONS);
    h.run(`insert into auth.users (id, email) values
      ('${NATE}','nate@bcn-services.com'), ('${BRANDON}','brandon@bcn-services.com')`);
    h.run(`insert into profiles (id, email, display_name) values
      ('${NATE}','nate@bcn-services.com','Nate'), ('${BRANDON}','brandon@bcn-services.com','Brandon')`);
    h.run(`insert into accounts (id, business_name, city, status)
      values ('${ACCOUNT}','Automation Test Co','Rye','new')`);
  });
  after(() => h?.stop());

  test("the tightened staff policy still admits ALL FIVE human kinds", () => {
    // The engineer's own version of this test checks 'call' only. The risk of a
    // `kind not in (...)` list is a typo that also excludes a human kind.
    for (const kind of HUMAN_KINDS) {
      const r = h.runClaims(brandon,
        `insert into account_activity (account_id, kind) values ('${ACCOUNT}','${kind}')`);
      assert.equal(r.ok, true, `member rejected for human kind '${kind}': ${r.error}`);
    }
  });

  test("NOT VALID skips only the backfill scan — new rows are still checked", () => {
    // Proof, not assumption: the constraint really is unvalidated, and an
    // offending INSERT is still refused on both the superuser and member paths.
    assert.equal(
      h.run(`select convalidated from pg_constraint where conname='account_activity_kind_check'`),
      "f",
      "expected the widened CHECK to be NOT VALID",
    );
    assert.equal(
      h.tryRun(`insert into account_activity (account_id, kind) values ('${ACCOUNT}','nonsense')`).ok,
      false,
      "a NOT VALID check must still reject a bad INSERT",
    );
    const viaPolicy = h.runClaims(brandon,
      `insert into account_activity (account_id, kind) values ('${ACCOUNT}','nonsense')`);
    assert.equal(viaPolicy.ok, false);
    // An UPDATE onto a bad value is checked too.
    h.run(`insert into account_activity (id, account_id, kind)
           values ('dddddddd-0000-4000-8000-0000000000f1','${ACCOUNT}','call')`);
    assert.equal(
      h.tryRun(`update account_activity set kind='nonsense'
                where id='dddddddd-0000-4000-8000-0000000000f1'`).ok,
      false,
    );
  });

  test("the down migration restores 0002's staff insert policy verbatim", () => {
    const inZeroTwo = readFileSync(
      fileURLToPath(new URL("../supabase/migrations/0002_rls_policies.sql", import.meta.url)), "utf8")
      .replace(/--[^\n]*/g, "")
      .match(/create\s+policy\s+account_activity_staff_insert[\s\S]*?;/i)[0]
      .replace(/\s+/g, " ").trim();
    const inDown = readFileSync(
      fileURLToPath(new URL("../supabase/migrations/0009_automation_schema.down.sql", import.meta.url)), "utf8")
      .replace(/--[^\n]*/g, "")
      .match(/create\s+policy\s+account_activity_staff_insert[\s\S]*?;/i)[0]
      .replace(/\s+/g, " ").trim();
    assert.equal(inDown, inZeroTwo);
  });

  test("up → down → up is clean, and down takes every 0009 index with it", () => {
    const NEW_INDEXES = ["inbox_items_profile_idx", "inbox_items_account_idx", "inbox_items_client_idx",
                         "lead_targets_created_by_idx", "job_runs_job_idx", "job_runs_unfinished_idx"];
    const c = startClusterWithMigrations(MIGRATIONS);
    try {
      const idxCount = () => c.run(
        `select count(*) from pg_class where relkind='i' and relname in (${
          NEW_INDEXES.map((i) => `'${i}'`).join(",")})`);
      assert.equal(idxCount(), String(NEW_INDEXES.length));

      const down = c.tryRunFile("0009_automation_schema.down.sql");
      assert.equal(down.ok, true, down.error);
      // The engineer's claim: no explicit index drops needed because the tables go.
      assert.equal(idxCount(), "0", "an index outlived the down migration");
      assert.equal(
        c.run(`select count(*) from pg_class where relname in ('inbox_items','lead_targets','job_runs')`),
        "0",
      );
      // 0002's staff policy is back and is the permissive one again.
      assert.match(
        c.run(`select pg_get_expr(polwithcheck, polrelid) from pg_policy
               where polname='account_activity_staff_insert'`),
        /is_staff/,
      );

      const up = c.tryRunFile("0009_automation_schema.sql");
      assert.equal(up.ok, true, `re-applying 0009 after the down failed: ${up.error}`);
      assert.equal(idxCount(), String(NEW_INDEXES.length));
      assert.match(
        c.run(`select pg_get_expr(polwithcheck, polrelid) from pg_policy
               where polname='account_activity_staff_insert'`),
        /ai_email_sent/,
        "the re-applied policy is not the narrowed one",
      );
    } finally {
      c.stop();
    }
  });

  test("a half-applied 0009 cannot happen — the file is one transaction", () => {
    // The reliability claim behind `begin; ... commit;`: if a later statement
    // fails, the CHECK swap must not be left half-done.
    const c = startClusterWithMigrations(MIGRATIONS.slice(0, 8));
    try {
      const src = readFileSync(
        fileURLToPath(new URL("../supabase/migrations/0009_automation_schema.sql", import.meta.url)), "utf8");
      assert.match(src, /^\s*begin;/m);
      assert.match(src, /commit;\s*$/);
      // Simulate a failure after the CHECK swap by replaying the file's own
      // prefix plus a deliberate error, in one transaction.
      const boom = c.tryRun(`begin;
        alter table account_activity drop constraint if exists account_activity_kind_check;
        select 1/0;
        commit;`);
      assert.equal(boom.ok, false);
      assert.equal(
        c.run(`select count(*) from pg_constraint where conname='account_activity_kind_check'`),
        "1",
        "the CHECK was lost despite the failure rolling back",
      );
    } finally {
      c.stop();
    }
  });
});
