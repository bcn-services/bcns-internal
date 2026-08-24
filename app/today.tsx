/**
 * today.tsx — the morning dashboard. It replaced a link list that duplicated the
 * sidebar verbatim: with the shell nav present, restating the routes told the
 * owner nothing, so the front door now answers "what needs me today" instead.
 *
 * Every number is derived from three list reads, not per-number queries. The
 * board is 2–6 users and a few thousand accounts, so counting in JS is cheaper
 * than a round trip per tile, and it keeps this page inside the injected-client
 * data layer rather than issuing its own PostgREST calls.
 *
 * The reads are wrapped together: a dev environment can legitimately be missing
 * the tasks or profiles tables, and a dashboard that 500s on the front door is
 * worse than one reporting zeroes with a banner.
 *
 * This was the whole of `/` until the brain graph took the front door. It is now
 * the second half of that page — still a server component, still the only thing
 * that reads the board — so `app/page.tsx` stays a thin composition.
 */
import Link from "next/link";
import { listAccounts, listClients, STAGES, TERMINAL_STAGES, type Account } from "@/lib/accounts";
import { listTasks, OPEN_STATUSES, type TaskWithRefs } from "@/lib/tasks";
import { listProfiles } from "@/lib/profiles";
import { getViewer } from "@/lib/supabase-server";

/** Stages still in play. The terminal three are history, not attention. */
const OPEN_STAGES = STAGES.filter((s) => !TERMINAL_STAGES.includes(s));

const ROWS = 8;

export default async function Today() {
  const { role, email, client: db } = await getViewer();
  // Dates are stored as YYYY-MM-DD, so a string compare is the date compare —
  // no timezone maths, and no Date object per row.
  const today = new Date().toISOString().slice(0, 10);

  let accounts: Account[] = [];
  let clients: { status: string }[] = [];
  let openTasks: TaskWithRefs[] = [];
  let me: string | null = null;
  let readFailed = false;

  if (db) {
    try {
      const [a, c, t, profiles] = await Promise.all([
        listAccounts(db),
        listClients(db),
        listTasks(db, { openOnly: true }),
        listProfiles(db),
      ]);
      accounts = a;
      clients = c;
      openTasks = t;
      // getViewer() hands back the session email, but tasks point at a profile
      // id, so the directory is the only bridge between the two.
      me = profiles.find((p) => p.email === email)?.id ?? null;
    } catch (err) {
      console.error("[dashboard] read failed:", err);
      readFailed = true;
    }
  }

  const isOverdue = (t: TaskWithRefs) =>
    t.due_date != null && t.due_date < today && OPEN_STATUSES.includes(t.status);

  // listTasks already orders soonest-due-first with undated work last, so every
  // slice below inherits that order for free.
  const overdue = openTasks.filter(isOverdue);
  const mine = me ? openTasks.filter((t) => t.assigned_to === me) : [];
  const activeClients = clients.filter((c) => c.status === "active");
  // An open lead with no owner is work nobody has agreed to do. Terminal stages
  // are excluded: a won or lost lead needs no owner and would otherwise bury
  // the live ones under history.
  const unowned = accounts.filter(
    (a) => a.assigned_to === null && (OPEN_STAGES as readonly string[]).includes(a.status),
  );

  const byStage = (stage: string) => accounts.filter((a) => a.status === stage).length;

  return (
    <>
      <h1>Today</h1>
      <p>Signed in as <strong>{role ?? "unprovisioned"}</strong>.</p>

      {!db && <p role="alert">Supabase is not configured, so every number below reads zero.</p>}
      {readFailed && <p role="alert">Could not read the database. The numbers below are not the real ones.</p>}

      {/* Every link in this block carries an explicit scope. The counts are
          board-wide, and /leads and /tasks now default a member to their own
          rows — so a bare link would show a member three of the forty-two they
          just clicked. */}
      <section aria-labelledby="counts">
        <h2 id="counts">Where things stand</h2>
        <dl>
          <div>
            <dt>Leads</dt>
            <dd><Link href="/leads?assigned=anyone">{accounts.length}</Link></dd>
          </div>
          {OPEN_STAGES.map((s) => (
            <div key={s}>
              <dt>{s.replace(/_/g, " ")}</dt>
              <dd><Link href={`/leads?status=${s}&assigned=anyone`}>{byStage(s)}</Link></dd>
            </div>
          ))}
          <div>
            <dt>Active clients</dt>
            <dd><Link href="/clients">{activeClients.length}</Link></dd>
          </div>
          <div>
            <dt>Open tasks</dt>
            <dd><Link href="/tasks?mine=0">{openTasks.length}</Link></dd>
          </div>
          <div>
            <dt>Overdue</dt>
            <dd style={overdue.length > 0 ? { color: "var(--danger)" } : undefined}>
              <Link href="/tasks?mine=0">{overdue.length}</Link>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="mine">
        <h2 id="mine">My open work</h2>
        {me == null ? (
          <p>No profile matches {email ?? "this session"}, so nothing can be assigned to you yet.</p>
        ) : mine.length === 0 ? (
          <p>Nothing assigned to you. <Link href="/tasks">The board</Link> has {openTasks.length} open.</p>
        ) : (
          <ul>
            {mine.slice(0, ROWS).map((t) => (
              <li key={t.id}>
                <Link href="/tasks">{t.title}</Link>
                {t.account && ` · ${t.account.business_name}`}
                {" · "}
                <span style={isOverdue(t) ? { color: "var(--danger)" } : undefined}>
                  {t.due_date ?? "no due date"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {mine.length > ROWS && <p><Link href="/tasks">All {mine.length} of mine</Link></p>}
      </section>

      <section aria-labelledby="attention">
        <h2 id="attention">Needs attention</h2>

        <h3>Overdue tasks</h3>
        {overdue.length === 0 ? (
          <p>Nothing overdue.</p>
        ) : (
          <ul>
            {overdue.slice(0, ROWS).map((t) => (
              <li key={t.id}>
                <span style={{ color: "var(--danger)" }}>{t.due_date}</span> ·{" "}
                <Link href="/tasks">{t.title}</Link>
                {t.assignee ? ` · ${t.assignee.display_name}` : " · unassigned"}
              </li>
            ))}
          </ul>
        )}
        {overdue.length > ROWS && <p><Link href="/tasks">All {overdue.length} overdue</Link></p>}

        <h3>Unassigned leads</h3>
        {unowned.length === 0 ? (
          <p>Every open lead has an owner.</p>
        ) : (
          <ul>
            {unowned.slice(0, ROWS).map((a) => (
              <li key={a.id}>
                <Link href={`/leads?status=${a.status}&assigned=unassigned`}>{a.business_name}</Link> ·{" "}
                {a.city ?? "—"} · <span style={{ color: "var(--warn)" }}>{a.status}</span>
              </li>
            ))}
          </ul>
        )}
        {unowned.length > ROWS && (
          <p><Link href="/leads?assigned=unassigned">All {unowned.length} unassigned</Link></p>
        )}
      </section>
    </>
  );
}
