/**
 * fake-db.mjs — a tiny in-memory stand-in for the supabase-js query builder.
 *
 * Why not the real Postgres harness: the verb layer talks PostgREST, and
 * tests/helpers/pg-cluster.mjs talks psql. Standing up PostgREST to test a
 * `select` shape would be a second harness for no extra guarantee — the
 * database's own rules (RLS, CHECKs, FKs) are already proven against real
 * Postgres in rls-policies / automation-schema-migration.
 *
 * Unlike the throwaway fakes in tasks-data-layer.test.mjs this one actually
 * HOLDS ROWS and applies eq/in/is/order/limit to them, because the things being
 * tested here — a derived open-task count, a money field being absent — are
 * about the data that comes back, not about which builder methods were called.
 *
 * Rows are copied on the way out, so a verb mutating its result cannot corrupt
 * the fixture and make a later test pass for the wrong reason.
 */

const clone = (row) => (row === null || typeof row !== "object" ? row : { ...row });

/**
 * @param tables {Record<string, object[]>} seeded rows, keyed by table name.
 * @param opts.failOn {Record<string,string>} table -> error message to return.
 * @param opts.throwOn {string} table name whose query throws instead.
 * @param opts.maxRows {number} PostgREST's server-side row cap (default 1000 in
 *   a real deployment). Set it to make a SELECT truncate the way the real one
 *   silently does, so an unpaginated reader is caught.
 * @param opts.unique {Record<string, string[][]>} table -> list of unique
 *   column tuples. A colliding INSERT comes back as SQLSTATE 23505 exactly as
 *   PostgREST reports it. Nulls never collide, matching a partial index.
 */
export function fakeDb(tables, opts = {}) {
  const calls = [];

  function from(table) {
    if (opts.throwOn === table) {
      throw new Error(`fake-db: exploding on ${table}`);
    }
    const rec = { table, ops: [] };
    calls.push(rec);

    const st = { mode: "select", cols: "", count: null, head: false, filters: [], orders: [], limit: null, range: null, payload: null };

    const rowsOf = () => (tables[table] ??= []);

    function selected() {
      let rows = rowsOf().map(clone).filter((r) => matches(r, st.filters));
      for (const o of [...st.orders].reverse()) {
        rows.sort((a, b) => {
          const [x, y] = [a[o.col], b[o.col]];
          if (x === y) return 0;
          if (x === null || x === undefined) return o.nullsFirst ? -1 : 1;
          if (y === null || y === undefined) return o.nullsFirst ? 1 : -1;
          return (x < y ? -1 : 1) * (o.ascending === false ? -1 : 1);
        });
      }
      // PostgREST semantics: range is inclusive on both ends.
      if (st.range !== null) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.limit !== null) rows = rows.slice(0, st.limit);
      // PostgREST truncates at its configured maximum and says nothing.
      if (opts.maxRows) rows = rows.slice(0, opts.maxRows);
      return rows.map((r) => embed(r, st.cols, tables));
    }

    function settle() {
      const fail = opts.failOn?.[table];
      if (fail) return Promise.resolve({ data: null, error: { message: fail } });

      if (st.mode === "insert") {
        // Unique constraints, because item 9's whole idempotency guarantee is
        // one (job_runs_window_idx, 0014) and a fake that let both inserts
        // succeed would prove the opposite of what the test claims. Partial in
        // the same way the real index is: a null in any of the columns is
        // never a collision, which is how the unwindowed interactive skill runs
        // stay exempt.
        for (const cols of opts.unique?.[table] ?? []) {
          const key = cols.map((c) => st.payload[c]);
          if (key.some((v) => v === null || v === undefined)) continue;
          const clash = rowsOf().some((r) => cols.every((c, i) => r[c] === key[i]));
          if (clash) {
            return Promise.resolve({
              data: null,
              error: {
                code: "23505",
                message: `duplicate key value violates unique constraint on (${cols.join(", ")})`,
              },
            });
          }
        }
        const row = { id: `fake-${table}-${rowsOf().length + 1}`, created_at: "2026-01-01T00:00:00Z", ...st.payload };
        rowsOf().push(row);
        return Promise.resolve({ data: clone(row), error: null });
      }
      if (st.mode === "update") {
        let touched = [];
        for (const row of rowsOf()) {
          // The SAME matcher the select path uses. An update whose filters are
          // read more loosely than a select's is how a conditional write looks
          // safe in a test and races in production — lib/briefing.ts's claim is
          // exactly such a write.
          if (matches(row, st.filters)) {
            Object.assign(row, st.payload);
            touched.push(clone(row));
          }
        }
        return Promise.resolve({ data: touched, error: null, _rows: touched });
      }
      // PostgREST's `select(cols, { count, head })`: `head` returns no rows at
      // all, only the count. lib/inbox.ts's badge query uses exactly that, and
      // a fake that ignored it would let a row-transferring count pass.
      const rows = selected();
      if (st.head || st.count) {
        return Promise.resolve({ data: st.head ? null : rows, count: rows.length, error: null });
      }
      return Promise.resolve({ data: rows, error: null });
    }

    const one = (allowEmpty) =>
      settle().then((res) => {
        if (res.error) return res;
        const rows = Array.isArray(res.data) ? res.data : [res.data];
        if (rows.length === 0) {
          return allowEmpty ? { data: null, error: null } : { data: null, error: { message: "no rows" } };
        }
        return { data: rows[0], error: null };
      });

    const b = {
      select: (cols, opts) => (
        (st.cols = cols ?? ""),
        (st.count = opts?.count ?? null),
        (st.head = opts?.head === true),
        rec.ops.push(["select", cols, opts]),
        b
      ),
      insert: (row) => ((st.mode = "insert"), (st.payload = row), rec.ops.push(["insert", row]), b),
      update: (row) => ((st.mode = "update"), (st.payload = row), rec.ops.push(["update", row]), b),
      eq: (col, val) => (st.filters.push({ op: "eq", col, val }), rec.ops.push(["eq", col, val]), b),
      neq: (col, val) => (st.filters.push({ op: "neq", col, val }), rec.ops.push(["neq", col, val]), b),
      lt: (col, val) => (st.filters.push({ op: "lt", col, val }), rec.ops.push(["lt", col, val]), b),
      in: (col, val) => (st.filters.push({ op: "in", col, val }), rec.ops.push(["in", col, val]), b),
      is: (col, val) => (st.filters.push({ op: "is", col, val }), rec.ops.push(["is", col, val]), b),
      or: (expr) => (st.filters.push({ op: "or", expr }), rec.ops.push(["or", expr]), b),
      order: (col, o = {}) => (st.orders.push({ col, ...o }), rec.ops.push(["order", col, o]), b),
      limit: (n) => ((st.limit = n), rec.ops.push(["limit", n]), b),
      range: (from, to) => ((st.range = [from, to]), rec.ops.push(["range", from, to]), b),
      single: () => (rec.ops.push(["single"]), one(false)),
      maybeSingle: () => (rec.ops.push(["maybeSingle"]), one(true)),
      then: (res, rej) => settle().then(res, rej),
    };
    return b;
  }

  return { from, calls };
}

/** One filter against one row. Shared by select and update — see the note there. */
function matchOne(row, f) {
  if (f.op === "in") return f.val.includes(row[f.col]);
  if (f.op === "neq") return row[f.col] !== f.val;
  if (f.op === "lt") return row[f.col] !== null && row[f.col] !== undefined && row[f.col] < f.val;
  if (f.op === "or") return matchOr(row, f.expr);
  // eq and is alike: the fake stores real nulls, so `is.null` IS an equality.
  return row[f.col] === f.val;
}

const matches = (row, filters) => filters.every((f) => matchOne(row, f));

/**
 * PostgREST's `or=(a.op.v,b.op.v)` as supabase-js spells it: a comma-separated
 * list of `column.operator.value`. Flat only — no nested `and(...)`, which
 * nothing in this codebase writes. `null` is spelled `null`, as PostgREST does.
 */
function matchOr(row, expr) {
  return String(expr)
    .split(",")
    .some((clause) => {
      const [col, op, ...rest] = clause.split(".");
      const raw = rest.join(".");
      const val = raw === "null" ? null : raw;
      return matchOne(row, { op, col, val });
    });
}

/** Reproduce the two PostgREST embeds the data layer asks for. */
function embed(row, cols, tables) {
  const out = { ...row };
  if (cols.includes("accounts(business_name)")) {
    const acct = (tables.accounts ?? []).find((a) => a.id === row.account_id);
    out.account = acct ? { business_name: acct.business_name } : null;
  }
  if (cols.includes("profiles!tasks_assigned_to_fkey(display_name)")) {
    const p = (tables.profiles ?? []).find((x) => x.id === row.assigned_to);
    out.assignee = p ? { display_name: p.display_name } : null;
  }
  return out;
}
