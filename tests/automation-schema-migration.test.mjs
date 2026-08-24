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

/** Every `create policy ... ;` statement in 0009, comments stripped. */
function policyStatements() {
  const src = readFileSync(
    fileURLToPath(new URL("../supabase/migrations/0009_automation_schema.sql", import.meta.url)),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  return [...src.matchAll(/create\s+policy[\s\S]*?;/gi)].map((m) => m[0]);
}

describe("0009 guardrails — independent QA", { skip: !toolsPresent && "no local Postgres" }, () => {
  test("no policy expression contains an unqualified function call", () => {
    const stmts = policyStatements();
    assert.equal(stmts.length, 6, `expected 6 policies in 0009, found ${stmts.length}`);
    // Everything after `using`/`with check` is expression territory. A call is
    // `name(` ; it is qualified only when preceded by `schema.`.
    for (const s of stmts) {
      for (const [, expr] of s.matchAll(/\b(?:using|with\s+check)\s*(\([\s\S]*?\))(?=\s*(?:using|with\s+check|;))/gi)) {
        for (const m of expr.matchAll(/(\.)?\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
          assert.equal(m[1], ".", `unqualified call ${m[2]}() in policy: ${s.split("\n")[0]}`);
        }
      }
    }
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
