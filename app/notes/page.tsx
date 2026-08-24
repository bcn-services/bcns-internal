/**
 * /notes — raw capture. Jot now, file later.
 *
 * Ported from project-dashboard's NotesPanel.astro, with two deliberate
 * differences:
 *
 *   1. Storage is Postgres (0003_project_manual.sql), not a JSON file on one
 *      laptop. That is the whole reason this page was blocked before.
 *   2. Auto-tagging is gone. The Astro version guessed a note's project by
 *      matching its text against project names; a wrong guess files a note
 *      where nobody looks for it. A note lands unsorted and a human files it.
 *
 * Structural port only — the visual pass is step 7, so this is plain markup.
 */
import Link from "next/link";
import OsNav from "@/components/OsNav";
import { getViewer } from "@/lib/supabase-server";
import { listNotes, type ProjectNote } from "@/lib/manual";
import { getProjects } from "@/lib/os/projects";
import type { Project } from "@/lib/os/types/project";
import { createNote, fileNote, removeNote } from "./actions";

export const dynamic = "force-dynamic";

/** The filter chip a note belongs under. UNSORTED is a real bucket, not a gap. */
const UNSORTED = "unsorted";

export default async function NotesPage({
  searchParams,
}: {
  searchParams?: { project?: string | string[]; error?: string | string[] };
}) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const filter = one(searchParams?.project);
  const error = one(searchParams?.error);

  const { role, email, client: db } = await getViewer();

  // Projects come from the filesystem, notes from Postgres. Either can fail
  // independently, and a failure of one must not blank the other — an unreadable
  // OS_DIR should still let you read your notes.
  let projects: Project[] = [];
  let projectsFailed = false;
  try {
    projects = await getProjects();
  } catch (err) {
    console.error("[notes] getProjects() failed:", err);
    projectsFailed = true;
  }

  let notes: ProjectNote[] = [];
  let notesFailed = false;
  if (db) {
    try {
      notes = await listNotes(db);
    } catch (err) {
      console.error("[notes] listNotes() failed:", err);
      notesFailed = true;
    }
  }

  const shown = filter
    ? notes.filter((n) => (filter === UNSORTED ? n.project_id === null : n.project_id === filter))
    : notes;

  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const unsortedCount = notes.filter((n) => n.project_id === null).length;

  return (
    <main>
      <OsNav current="/notes" />
      <h1>Notes</h1>

      {error && <p role="alert"><strong>Could not save:</strong> {error}</p>}
      {!db && <p role="alert">Supabase is not configured, so notes cannot be read or written.</p>}
      {notesFailed && <p role="alert">Could not read notes. Check the database connection.</p>}
      {projectsFailed && <p role="alert">Could not read projects, so filing a note is unavailable.</p>}

      <form action={createNote}>
        <label>
          New note
          <textarea name="body" rows={3} maxLength={2000} required
            placeholder="What happened? File it to a project now, or leave it unsorted." />
        </label>
        <label>
          Project
          <select name="projectId" defaultValue="">
            <option value="">— unsorted —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <button type="submit">Save note</button>
      </form>

      <nav aria-label="Filter notes by project">
        <Link href="/notes">All ({notes.length})</Link>
        {" · "}
        <Link href={`/notes?project=${UNSORTED}`}>Unsorted ({unsortedCount})</Link>
        {projects.map((p) => {
          const n = notes.filter((x) => x.project_id === p.id).length;
          return n === 0 ? null : (
            <span key={p.id}> · <Link href={`/notes?project=${p.id}`}>{p.name} ({n})</Link></span>
          );
        })}
      </nav>

      {shown.length === 0 && <p>No notes here yet.</p>}

      <ul>
        {shown.map((n) => (
          <li key={n.id}>
            <p>{n.body}</p>
            <p>
              <small>
                {/* project_id may name a directory that no longer exists — 0003
                    has no FK, by design. Fall back to the raw id rather than
                    hiding a note whose project was renamed or deleted. */}
                {n.project_id ? (nameOf.get(n.project_id) ?? `${n.project_id} (missing)`) : "unsorted"}
                {" · "}
                <time dateTime={n.created_at}>{n.created_at.slice(0, 10)}</time>
                {n.author_email ? ` · ${n.author_email}` : ""}
              </small>
            </p>

            <form action={fileNote}>
              <input type="hidden" name="id" value={n.id} />
              <select name="projectId" defaultValue={n.project_id ?? ""}>
                <option value="">— unsorted —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button type="submit">File</button>
            </form>

            {/* Shown for your own notes, and for an admin on any note. The
                database enforces the same rule against a forged post, so this
                is convenience, not the control. */}
            {(role === "admin" || (n.author_email !== null && n.author_email === email)) && (
              <form action={removeNote}>
                <input type="hidden" name="id" value={n.id} />
                <button type="submit">Delete</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
