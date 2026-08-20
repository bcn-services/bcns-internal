/**
 * /projects — the project board, ported from ProjectsPanel.astro.
 *
 * Mounted at `/projects` rather than the section's own `/` href: `/` is the
 * bcns front door here. See components/OsNav.tsx.
 *
 * Structural port only. The Astro panel also rendered NextUp (recommend.ts),
 * WeeklyDigest (digest.ts over MergedProject) and per-card manual overrides —
 * all of which need merge.ts / manual.ts / recommend.ts, none of which are
 * ported. So this reads getProjects() and buckets by status, nothing more.
 */
import Link from "next/link";
import OsNav from "@/components/OsNav";
import { getProjects } from "@/lib/os/projects";
import type { Project } from "@/lib/os/types/project";

export const dynamic = "force-dynamic";

const BOARD_STATUSES = ["active", "in-progress", "on-hold"] as const;
const COLLAPSED_STATUSES = new Set(["complete", "archived"]);

const SECTION_LABELS: Record<(typeof BOARD_STATUSES)[number], string> = {
  active: "Active",
  "in-progress": "In Progress",
  "on-hold": "On Hold",
};

/** The design writes section counts two-up: "03", not "3". */
const pad2 = (n: number) => String(n).padStart(2, "0");

export default async function ProjectsPage() {
  let allProjects: Project[] = [];
  let loadError = false;
  try {
    allProjects = await getProjects();
  } catch (err) {
    console.error("[projects] getProjects() failed:", err);
    loadError = true;
  }

  const buckets: Record<(typeof BOARD_STATUSES)[number], Project[]> = {
    active: [],
    "in-progress": [],
    "on-hold": [],
  };
  const completed: Project[] = [];

  for (const project of allProjects) {
    if (COLLAPSED_STATUSES.has(project.status)) {
      completed.push(project);
      continue;
    }
    const s = project.status as (typeof BOARD_STATUSES)[number];
    if (s in buckets) buckets[s].push(project);
  }

  return (
    <main>
      <OsNav current="/" />
      <h1>Projects</h1>

      {loadError && <p role="alert">Failed to load projects. Check OS_DIR / OS_PROJECTS_DIR.</p>}

      {BOARD_STATUSES.map((status) => (
        <section key={status} aria-labelledby={`section-${status}`}>
          <h2 id={`section-${status}`}>
            {SECTION_LABELS[status]} {pad2(buckets[status].length)}
          </h2>
          {buckets[status].length === 0 ? (
            <p>Nothing here.</p>
          ) : (
            <ul>
              {buckets[status].map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong>
                  {p.summary ? ` — ${p.summary}` : ""}
                  <dl>
                    <dt>Priority</dt>
                    <dd>{p.priority}</dd>
                    <dt>Next step</dt>
                    <dd>{p.next_step ?? "—"}</dd>
                    <dt>Last active</dt>
                    <dd>{p.days_since_active}d ago</dd>
                  </dl>
                  {p.github && <a href={p.github}>GitHub</a>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {completed.length > 0 && (
        <details>
          <summary>Completed ({completed.length})</summary>
          <ul>
            {completed.map((p) => (
              <li key={p.id}>
                {p.name} — {p.status}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
