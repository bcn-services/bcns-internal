/**
 * /projects — the project board, ported from ProjectsPanel.astro.
 *
 * Mounted at `/projects` rather than the section's own `/` href: `/` is the
 * bcns front door here. See components/OsNav.tsx.
 *
 * Two sources, merged: the project itself comes from the filesystem under
 * OS_DIR, and the manual layer (field overrides, due date, hidden fields)
 * comes from Postgres. The filesystem is the source of truth; the manual layer
 * is a correction sitting on top of it. Nothing here writes to a README.
 *
 * Still not ported: NextUp (recommend.ts) and WeeklyDigest (digest.ts).
 * Structural port only — the visual pass is step 7.
 */
import Link from "next/link";
import OsNav from "@/components/OsNav";
import { getViewer } from "@/lib/supabase-server";
import { getProjects } from "@/lib/os/projects";
import type { Project } from "@/lib/os/types/project";
import {
  applyManualLayer, loadManualLayer, OVERRIDE_FIELDS,
  type ManualLayer, type Merged,
} from "@/lib/manual";
import { saveOverride, saveDueDate, saveFieldHidden } from "./actions";

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

const EMPTY_LAYER: ManualLayer = { overrides: {}, settings: {} };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams?: { error?: string | string[] };
}) {
  const rawError = searchParams?.error;
  const error = Array.isArray(rawError) ? rawError[0] : rawError;

  const { role, client: db } = await getViewer();

  let allProjects: Project[] = [];
  let loadError = false;
  try {
    allProjects = await getProjects();
  } catch (err) {
    console.error("[projects] getProjects() failed:", err);
    loadError = true;
  }

  // The manual layer failing must not blank the board. A board with stale
  // README values still tells you what you have; a blank one tells you nothing.
  let layer = EMPTY_LAYER;
  let layerFailed = false;
  if (db) {
    try {
      layer = await loadManualLayer(db);
    } catch (err) {
      console.error("[projects] loadManualLayer() failed:", err);
      layerFailed = true;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const projects = applyManualLayer(allProjects, layer, today);
  const canEdit = role !== null && db !== null;

  const buckets: Record<(typeof BOARD_STATUSES)[number], Merged<Project>[]> = {
    active: [],
    "in-progress": [],
    "on-hold": [],
  };
  const completed: Merged<Project>[] = [];

  for (const project of projects) {
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

      {error && <p role="alert"><strong>Could not save:</strong> {error}</p>}
      {loadError && <p role="alert">Failed to load projects. Check OS_DIR / OS_PROJECTS_DIR.</p>}
      {layerFailed && <p role="alert">Showing README values only — the manual overrides could not be read.</p>}

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
                    {/* A hidden field is hidden from the BOARD, not from the
                        editor below — hiding it there would make it
                        unrecoverable once hidden. */}
                    {!p.hidden_fields.priority && (
                      <>
                        <dt>Priority</dt>
                        <dd>{p.priority}</dd>
                      </>
                    )}
                    <dt>Next step</dt>
                    <dd>{p.next_step ?? "—"}</dd>
                    {!p.hidden_fields.due_date && (
                      <>
                        <dt>Due</dt>
                        <dd>{p.due_date ?? "—"}{p.overdue && " (overdue)"}</dd>
                      </>
                    )}
                    <dt>Last active</dt>
                    <dd>{p.days_since_active}d ago</dd>
                  </dl>
                  {p.github && <a href={p.github}>GitHub</a>}
                  {p.overridden.length > 0 && (
                    <p><small>Manually set: {p.overridden.join(", ")}</small></p>
                  )}

                  {canEdit && (
                    <details>
                      <summary>Edit this project</summary>

                      {OVERRIDE_FIELDS.map((field) => (
                        <form key={field} action={saveOverride}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <input type="hidden" name="field" value={field} />
                          <label>
                            {field}
                            <input
                              name="value"
                              defaultValue={layer.overrides[p.id]?.[field] ?? ""}
                              placeholder={`from README: ${
                                (allProjects.find((x) => x.id === p.id) as
                                  | Record<string, unknown>
                                  | undefined)?.[field] ?? "—"
                              }`}
                            />
                          </label>
                          {/* Empty clears the override and the README value
                              shows through again. Said out loud because an
                              empty box that means "revert" is not obvious. */}
                          <button type="submit">Save (empty clears)</button>
                        </form>
                      ))}

                      <form action={saveDueDate}>
                        <input type="hidden" name="projectId" value={p.id} />
                        <label>
                          Due date
                          <input type="date" name="date" defaultValue={p.due_date ?? ""} />
                        </label>
                        <button type="submit">Save due date</button>
                      </form>

                      {(["due_date", "priority"] as const).map((field) => (
                        <form key={field} action={saveFieldHidden}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <input type="hidden" name="field" value={field} />
                          {/* The DESIRED state is submitted, not a flip of what
                              was last rendered, so two people editing the same
                              board do not undo each other. */}
                          <input
                            type="hidden"
                            name="hidden"
                            value={p.hidden_fields[field] ? "0" : "1"}
                          />
                          <button type="submit">
                            {p.hidden_fields[field] ? `Show ${field}` : `Hide ${field}`}
                          </button>
                        </form>
                      ))}
                    </details>
                  )}
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
