/**
 * admin/page.tsx — the staff directory and the automation's configuration.
 *
 * GATING. middleware.ts already forbade every non-admin through lib/auth.ts's
 * pure decision, and a forbid is a 403 response, NOT a redirect to login —
 * a member who types /admin is told no, not shown a sign-in form they are
 * already past. The `role !== "admin"` branch below is a belt on top of those
 * braces for the case where the gate is somehow bypassed, and every mutating
 * control on this page re-checks in ./actions.ts and is checked again by RLS.
 * Hiding the nav link is not on that list and never was.
 *
 * There is deliberately NO "create user" form. Creating an auth user needs the
 * service-role key, which bypasses RLS entirely — a page that could reach it
 * would be one XSS or one leaked bundle away from handing out the database.
 * Provisioning therefore stays a terminal command run by an operator. Same
 * argument, differently shaped, is why the re-enroll control in ./panels.tsx
 * is prose: a server cannot log in as somebody.
 */
import { getViewer } from "@/lib/supabase-server";
import { listProfiles } from "@/lib/profiles";
import { allEnrollments } from "@/lib/agent/tokens";
import { skillButtonsFor } from "@/lib/agent/skills";
import {
  JOB_FUNCTIONS,
  listJobRuns,
  listLeadTargets,
  tokenPanelRows,
  type JobRunRecord,
  type LeadTargetRow,
  type TokenPanelRow,
} from "@/lib/admin";
import SkillButtons from "../skill-buttons";
import { JobHistory, TokenPanel } from "./panels";
import { addTarget, setPersonJobFunction, setTargetActive } from "./actions";

export const dynamic = "force-dynamic";

/** How many runs the history panel shows before it stops being a history. */
const RUN_LIMIT = 40;

/**
 * Read something, or say the panel is unavailable.
 *
 * Four independent reads back this page and one of them (`agent_tokens`) goes
 * through the service role. A failure in any one degrades that panel rather
 * than taking down the staff directory, which is the older and more important
 * half of the page.
 */
async function panel<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[admin] could not read ${label}:`, err);
    return null;
  }
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  const { role, client: db } = await getViewer();

  if (role !== "admin") {
    return (
      <main>
        <h1>Admin</h1>
        <p role="alert">This page is for administrators.</p>
      </main>
    );
  }

  const profiles = db ? await panel("profiles", () => listProfiles(db)) ?? [] : [];

  const [enrollments, targets, runs] = await Promise.all([
    panel("agent seats", allEnrollments),
    db ? panel<LeadTargetRow[]>("lead_targets", () => listLeadTargets(db)) : null,
    db ? panel<JobRunRecord[]>("job_runs", () => listJobRuns(db, RUN_LIMIT)) : null,
  ]);

  // Built here rather than in the panel so the component stays a pure function
  // of plain props — see the note at the top of ./panels.tsx.
  const seats: TokenPanelRow[] | null = enrollments
    ? tokenPanelRows(profiles, enrollments)
    : null;

  return (
    <main>
      <h1>Admin</h1>

      {searchParams?.error && <p role="alert">{searchParams.error}</p>}

      {/* Admin-only by role, so job_function is not consulted: a null or
          `developer` job_function must not strip an admin of their own
          controls. Role grants these; job_function only ever narrows the
          member-visible sets. */}
      <SkillButtons buttons={skillButtonsFor("admin", role, null)} />

      {/* ------------------------------------------------- staff + function -- */}
      <section>
        <h2>Staff</h2>
        <p>{profiles.length} {profiles.length === 1 ? "person" : "people"}.</p>
        <table>
          <caption>
            Job function decides which skill buttons somebody sees. It is not a
            role and grants nothing — the skill route authorizes on
            admin/member whatever the page rendered.
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Active</th>
              <th scope="col">Job function</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.display_name}</th>
                <td>{p.email}</td>
                <td>{p.active ? "yes" : "no"}</td>
                <td>
                  <form action={setPersonJobFunction}>
                    <input type="hidden" name="profileId" value={p.id} />
                    {/* aria-label rather than a visible <label>: the column
                        header already names the field, and forty repeats of
                        "Job function" down the column is noise on screen and
                        in a screen reader alike. The name still says WHOSE. */}
                    <select
                      name="jobFunction"
                      defaultValue={p.job_function ?? ""}
                      aria-label={`Job function for ${p.display_name}`}
                    >
                      <option value="">— none —</option>
                      {JOB_FUNCTIONS.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                    <button type="submit">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {profiles.length === 0 && <p>Nobody is provisioned yet.</p>}
      </section>

      {/* ------------------------------------------------------ lead targets -- */}
      <section>
        <h2>Lead targets</h2>
        <p>
          Where the weekly sweep prospects. Deactivating one stops the sweep
          selecting it; it <strong>deletes nothing</strong> — the target stays
          on this list, and every lead it already produced is untouched.
        </p>

        {targets === null && <p role="alert">Could not read the target list.</p>}

        {targets !== null && (
          <table>
            <thead>
              <tr>
                <th scope="col">Trade</th>
                <th scope="col">Town</th>
                <th scope="col">In the sweep</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.trade}</th>
                  <td>{t.town}</td>
                  <td data-tone={t.active ? "ok" : "neutral"}>
                    {t.active ? "yes" : "no — skipped"}
                  </td>
                  <td>
                    <form action={setTargetActive}>
                      <input type="hidden" name="id" value={t.id} />
                      <input type="hidden" name="active" value={t.active ? "false" : "true"} />
                      <button type="submit">{t.active ? "Deactivate" : "Reactivate"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {targets?.length === 0 && (
          <p>
            No targets yet. The sweep falls back to segments with enough win
            data and invents nothing, so an empty list means it may prospect
            nowhere at all.
          </p>
        )}

        <form action={addTarget}>
          <label>
            Trade
            <input name="trade" required maxLength={120} placeholder="roofer" />
          </label>
          <label>
            Town
            <input name="town" required maxLength={120} placeholder="Mamaroneck" />
          </label>
          <button type="submit">Add target</button>
        </form>
      </section>

      {/* ------------------------------------------------------------ seats -- */}
      {seats === null ? (
        <section>
          <h2>Agent seats</h2>
          <p role="alert">Could not read seat status.</p>
        </section>
      ) : (
        <TokenPanel rows={seats} />
      )}

      {/* ------------------------------------------------------------- runs -- */}
      {runs === null ? (
        <section>
          <h2>Job history</h2>
          <p role="alert">Could not read the run history.</p>
        </section>
      ) : (
        <JobHistory runs={runs} />
      )}

      {/* ---------------------------------------------------------- adding -- */}
      <section>
        <h2>Adding someone</h2>
        <p>Run this from the repo, then send them the sign-in link it prints:</p>
        <pre><code>npm run provision-user -- someone@bcn-services.com member &quot;Their Name&quot;</code></pre>
        <p>
          It is a terminal command and not a button because it needs the
          service-role key, which bypasses RLS and must never be shipped to a page.
        </p>
      </section>
    </main>
  );
}
