/**
 * tasks/page.tsx — the working board: what is outstanding, who owns it, and
 * when it is due. This is the page the team actually sits on all day.
 *
 * THE DEFAULT VIEW DEPENDS ON WHO YOU ARE. A member lands on their own queue,
 * because "what do I do next" is the question they open this page with; an
 * admin lands on the whole board, because "who is loaded and who is idle" is
 * the question they open it with. Either can see the other view in one click —
 * this is a default, not a wall, and every task stays readable to everyone.
 *
 * WHICH CONTROLS RENDER IS ALSO ROLE-DEPENDENT, and that hiding is convenience.
 * The control is `tasks_staff_own_update` in 0007: a member's UPDATE matches
 * only rows assigned to them, and its WITH CHECK stops them reassigning even
 * those. Forging a form field against a colleague's task gets a denial from
 * Postgres, not a save.
 *
 * Forms post to server actions in ./actions.ts. No client-side JavaScript is
 * required for any of it, which is why the buttons are plain form submits and
 * a filter is a link rather than a control.
 */
import Link from "next/link";
import { getViewer } from "@/lib/supabase-server";
import { listTasks, TASK_STATUSES, type TaskStatus } from "@/lib/tasks";
import { listProfiles } from "@/lib/profiles";
import { listAccounts } from "@/lib/accounts";
import { addTask, setStatus, setAssignee } from "./actions";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; mine?: string; open?: string; error?: string }>;
}) {
  const { status, mine, open, error } = await searchParams;
  const filter = (TASK_STATUSES as readonly string[]).includes(status ?? "")
    ? (status as TaskStatus)
    : undefined;

  const { role, email, client: db } = await getViewer();

  const profiles = db ? await listProfiles(db) : [];
  // getViewer() gives the session email, not the auth user id — and profiles.id
  // IS that id, so the directory is the bridge. Matched case-insensitively
  // because an email is not case-sensitive on the local part in practice.
  const me = email
    ? profiles.find((p) => p.email.toLowerCase() === email.toLowerCase())
    : undefined;

  // "Mine" with no profile row would silently list everything, which reads as a
  // bug. Filter on an id that matches nothing instead, so the board is honest.
  // Absent means "use my default", which differs by role — see the header.
  // `?mine=0` is how either role asks for the other view, so the choice
  // survives a refresh and a shared link.
  const isAdmin = role === "admin";
  const mineOnly = mine === undefined ? !isAdmin : mine === "1";
  const tasks =
    db && !(mineOnly && !me)
      ? await listTasks(db, {
          ...(filter ? { status: filter } : {}),
          ...(mineOnly && me ? { assignedTo: me.id } : {}),
          ...(open === "1" ? { openOnly: true } : {}),
        })
      : [];

  const assignable = profiles.filter((p) => p.active);
  const accounts = db ? await listAccounts(db) : [];

  return (
    <main>
      <h1>Tasks</h1>
      {/* Set by a server action that failed — a permission denial, usually. */}
      {error && <p role="alert"><strong>Could not save:</strong> {error}</p>}

      <nav aria-label="Filter tasks">
        <Link href="/tasks?mine=0">All</Link>
        <Link href="/tasks?mine=1">Mine</Link>
        <Link href="/tasks?open=1">Open</Link>
        {TASK_STATUSES.map((s) => (
          <Link key={s} href={`/tasks?status=${s}&mine=${mineOnly ? "1" : "0"}`}>{s}</Link>
        ))}
      </nav>

      <p>
        {tasks.length} shown
        {mineOnly ? ", assigned to me" : ""}
        {open === "1" ? ", open only" : ""}
        {filter ? ` in ${filter}` : ""}.
        {mineOnly && !me && " You have no profile row yet, so nothing is assigned to you."}
      </p>

      <h2>New task</h2>
      <form action={addTask}>
        <input name="title" placeholder="What needs doing?" required />
        <input name="details" placeholder="Details (optional)" />
        <label>
          Due <input type="date" name="dueDate" />
        </label>
        <select name="assignedTo" defaultValue="">
          <option value="">Unassigned</option>
          {assignable.map((p) => (
            <option key={p.id} value={p.id}>{p.display_name}</option>
          ))}
        </select>
        <select name="accountId" defaultValue="">
          <option value="">No account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.business_name}</option>
          ))}
        </select>
        <button type="submit">Add task</button>
      </form>

      {tasks.length === 0 && <p>Nothing here yet.</p>}

      {tasks.map((t) => {
        const isMine = me != null && t.assigned_to === me.id;
        // An offboarded assignee is missing from the picker, and a select whose
        // value is absent falls back to the first option — which would silently
        // unassign the task on save. Keep the current holder in the list.
        const options = profiles.filter((p) => p.active || p.id === t.assigned_to);
        return (
          <article key={t.id}>
            <h2>{isMine ? <strong>{t.title}</strong> : t.title}</h2>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{t.status}</dd>
              </div>
              <div>
                <dt>Assignee</dt>
                <dd>
                  {t.assignee?.display_name ?? "Unassigned"}
                  {isMine ? " (you)" : ""}
                </dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{t.account?.business_name ?? "—"}</dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd>{t.due_date ?? "no date"}</dd>
              </div>
            </dl>
            {t.details && <p>{t.details}</p>}

            {/* A member sees this only on their own work. Rendering it on a
                colleague's task would offer a save that RLS refuses. */}
            {(isMine || isAdmin) && (
            <form action={setStatus}>
              <input type="hidden" name="taskId" value={t.id} />
              <label>
                Move to{" "}
                <select name="status" defaultValue={t.status}>
                  {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <button type="submit">Save status</button>
            </form>
            )}

            {/* Assignment is an admin action. 0007's WITH CHECK is what makes
                that true; this only keeps a member from being offered it. */}
            {isAdmin && (
            <form action={setAssignee}>
              <input type="hidden" name="taskId" value={t.id} />
              <label>
                Assign to{" "}
                <select name="assignedTo" defaultValue={t.assigned_to ?? ""}>
                  <option value="">Unassigned</option>
                  {options.map((p) => (
                    <option key={p.id} value={p.id}>{p.display_name}</option>
                  ))}
                </select>
              </label>
              <button type="submit">Save assignee</button>
            </form>
            )}
          </article>
        );
      })}
    </main>
  );
}
