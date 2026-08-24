/**
 * /insights — the rolling view of the business.
 *
 * The Astro page this replaces reported Claude token usage and git commit
 * momentum off one laptop. Those inputs do not exist on a server and were never
 * bcns metrics, so the page keeps its shape (KPI tiles, a rolling window, a
 * momentum series) and reports the funnel, the contact history and the project
 * board instead. See lib/insights.ts.
 *
 * Structural port only — the visual pass is step 7, so the momentum series is
 * a table, not a sparkline.
 */
import Link from "next/link";
import OsNav from "@/components/OsNav";
import { getViewer } from "@/lib/supabase-server";
import { STAGES } from "@/lib/accounts";
import { loadManualLayer, applyManualLayer, type ManualLayer } from "@/lib/manual";
import { getProjects } from "@/lib/os/projects";
import type { Project } from "@/lib/os/types/project";
import {
  activityByDay, buildKpis, funnelCounts, WINDOW_DAYS,
  type AccountPoint, type ActivityPoint, type ClientPoint,
} from "@/lib/insights";

export const dynamic = "force-dynamic";

const EMPTY_LAYER: ManualLayer = { overrides: {}, settings: {} };
const OPEN_PROJECT_STATUSES = new Set(["active", "in-progress"]);

export default async function InsightsPage() {
  const { client: db } = await getViewer();
  const today = new Date().toISOString().slice(0, 10);

  let accounts: AccountPoint[] = [];
  let clients: ClientPoint[] = [];
  let activity: ActivityPoint[] = [];
  let dbFailed = false;

  if (db) {
    try {
      // Three reads, not a join: each feeds a different tile, and a join would
      // multiply activity rows by account rows and inflate every count.
      const [a, c, act] = await Promise.all([
        db.from("accounts").select("status, deal_value_cents, created_at"),
        db.from("clients").select("status, monthly_rate_cents"),
        // Only the window is fetched. The activity table grows forever and
        // nothing on this page reads past it.
        db.from("account_activity").select("occurred_at")
          .gte("occurred_at", `${cutoff(today)}T00:00:00Z`),
      ]);
      for (const res of [a, c, act]) if (res.error) throw new Error(res.error.message);
      accounts = (a.data ?? []) as AccountPoint[];
      clients = (c.data ?? []) as ClientPoint[];
      activity = (act.data ?? []) as ActivityPoint[];
    } catch (err) {
      console.error("[insights] read failed:", err);
      dbFailed = true;
    }
  }

  let projects: Project[] = [];
  let projectsFailed = false;
  try {
    projects = await getProjects();
  } catch (err) {
    console.error("[insights] getProjects() failed:", err);
    projectsFailed = true;
  }

  let layer = EMPTY_LAYER;
  if (db && !dbFailed) {
    try {
      layer = await loadManualLayer(db);
    } catch (err) {
      console.error("[insights] loadManualLayer() failed:", err);
    }
  }

  const merged = applyManualLayer(projects, layer, today);
  const openProjects = merged.filter((p) => OPEN_PROJECT_STATUSES.has(p.status));

  const kpis = buildKpis({
    accounts, clients, activity, today,
    activeProjects: openProjects.length,
    overdueProjects: openProjects.filter((p) => p.overdue).length,
  });
  const series = activityByDay(activity, today);
  const funnel = funnelCounts(accounts, STAGES);
  const busiest = Math.max(1, ...series.map((d) => d.count));

  return (
    <main>
      <OsNav current="/insights" />
      <h1>Insights</h1>
      <p>Rolling {WINDOW_DAYS}-day window ending {today}.</p>

      {!db && <p role="alert">Supabase is not configured, so every business number below reads zero.</p>}
      {dbFailed && <p role="alert">Could not read the database. The numbers below are not the real ones.</p>}
      {projectsFailed && <p role="alert">Could not read projects. The project tile is not the real number.</p>}

      <section aria-labelledby="kpis">
        <h2 id="kpis">Headline</h2>
        <dl>
          {kpis.map((k) => (
            <div key={k.label}>
              <dt>{k.label}</dt>
              <dd>{k.value} — {k.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="momentum">
        <h2 id="momentum">Contacts per day</h2>
        <table>
          <caption>Every call, email, meeting and note logged, by day.</caption>
          <thead>
            <tr><th scope="col">Day</th><th scope="col">Contacts</th></tr>
          </thead>
          <tbody>
            {series.map((d) => (
              <tr key={d.day}>
                <th scope="row">{d.day}</th>
                {/* A bar drawn in text until step 7 replaces it with a real one.
                    Scaled to the busiest day so a quiet window still has shape. */}
                <td>{d.count} <span className="bar" aria-hidden="true" style={{ color: "var(--accent)" }}>{"▪".repeat(Math.round((d.count / busiest) * 20))}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="funnel">
        <h2 id="funnel">Funnel</h2>
        <table>
          <thead>
            <tr><th scope="col">Stage</th><th scope="col">Accounts</th></tr>
          </thead>
          <tbody>
            {funnel.map((f) => (
              <tr key={f.stage}>
                <th scope="row">{f.stage}</th>
                <td>{f.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p><Link href="/leads">Leads</Link> · <Link href="/clients">Clients</Link></p>
    </main>
  );
}

/** First day of the window, as YYYY-MM-DD. */
function cutoff(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - (WINDOW_DAYS - 1) * 86_400_000)
    .toISOString().slice(0, 10);
}
