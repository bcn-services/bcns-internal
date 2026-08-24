/**
 * manual.ts — the manual layer over the project board: field overrides, per-
 * project settings, and notes.
 *
 * Ported from project-dashboard's src/lib/manual.ts, which held all of this in
 * one JSON file on one laptop, guarded by an in-process mutex. Both are gone.
 * The mutex went because `insert ... on conflict do update` is atomic in
 * Postgres, so there is no read-modify-write window left to protect. Storage
 * is supabase/migrations/0003_project_manual.sql.
 *
 * Same platform rule as accounts.ts: the Supabase client is INJECTED. This
 * module reads no env, imports no `server-only`, and builds no client, so it
 * stays testable with a fake. Authorization is RLS's job, not this file's.
 */

import { InvalidInputError } from "./accounts";

/** The project fields a human may override. Identical to the DB CHECK in 0003. */
export const OVERRIDE_FIELDS = [
  "name", "summary", "status", "priority", "next_step", "repo", "github",
] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

export const isOverrideField = (v: unknown): v is OverrideField =>
  typeof v === "string" && (OVERRIDE_FIELDS as readonly string[]).includes(v);

/** The two fields a project may hide from the board. Matches 0003's columns. */
export const HIDEABLE_FIELDS = ["due_date", "priority"] as const;
export type HideableField = (typeof HIDEABLE_FIELDS)[number];

export const isHideableField = (v: unknown): v is HideableField =>
  typeof v === "string" && (HIDEABLE_FIELDS as readonly string[]).includes(v);

/** The note length cap. Same number the DB CHECK enforces, so both agree. */
export const MAX_NOTE_LENGTH = 2000;

/**
 * A project id is a directory name under OS_DIR, not a UUID — there is no FK to
 * validate against, so this is the whole check. Kept strict enough that a path
 * fragment or an empty string never reaches the database.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const isProjectId = (v: unknown): v is string =>
  typeof v === "string" && PROJECT_ID_RE.test(v);

/** ISO calendar date, the only shape the `date` column accepts unambiguously. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ProjectOverride {
  project_id: string;
  field: OverrideField;
  value: string;
  updated_by: string | null;
  updated_at: string;
}

export interface ProjectSettings {
  project_id: string;
  due_date: string | null;
  hide_due_date: boolean;
  hide_priority: boolean;
  updated_by: string | null;
  updated_at: string;
}

export interface ProjectNote {
  id: string;
  project_id: string | null;
  body: string;
  author_email: string | null;
  created_at: string;
}

/**
 * Everything the board needs to render its manual layer, in the shape the page
 * actually consumes: keyed by project id so a render is a lookup, not a scan.
 */
export interface ManualLayer {
  overrides: Record<string, Partial<Record<OverrideField, string>>>;
  settings: Record<string, ProjectSettings>;
}

// Same minimal structural type accounts.ts uses, for the same reason: this file
// must not import @supabase/supabase-js, or it stops being fake-testable.
type Result<T> = { data: T | null; error: { message: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client_ = any;

function unwrap<T>(res: Result<T>, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data`);
  return res.data;
}

/**
 * Read the whole manual layer in two queries.
 *
 * Two, not one per project: the board renders every project at once, so a
 * per-project read would be an N+1 against a table that will hold tens of rows.
 */
export async function loadManualLayer(db: Client_): Promise<ManualLayer> {
  const rows = unwrap<ProjectOverride[]>(
    await db.from("project_overrides").select("project_id, field, value, updated_by, updated_at"),
    "loadManualLayer/overrides",
  );
  const settingsRows = unwrap<ProjectSettings[]>(
    await db.from("project_settings")
      .select("project_id, due_date, hide_due_date, hide_priority, updated_by, updated_at"),
    "loadManualLayer/settings",
  );

  const overrides: ManualLayer["overrides"] = {};
  for (const row of rows) {
    (overrides[row.project_id] ??= {})[row.field] = row.value;
  }
  const settings: ManualLayer["settings"] = {};
  for (const row of settingsRows) settings[row.project_id] = row;

  return { overrides, settings };
}

/**
 * Set or clear one overridden field.
 *
 * A blank value CLEARS rather than storing an empty string: the two would
 * otherwise both render as "no value" while behaving differently on read, and
 * a form always submits a string, so "" is what a user typing nothing sends.
 */
export async function setOverride(
  db: Client_,
  input: { projectId: string; field: string; value: string | null; actor?: string | null },
): Promise<void> {
  if (!isProjectId(input.projectId)) throw new InvalidInputError(`bad project id: ${input.projectId}`);
  if (!isOverrideField(input.field)) throw new InvalidInputError(`not an overridable field: ${input.field}`);

  const value = input.value?.trim() ?? "";
  if (value === "") {
    const res: Result<unknown> = await db
      .from("project_overrides")
      .delete()
      .eq("project_id", input.projectId)
      .eq("field", input.field);
    if (res.error) throw new Error(`setOverride/clear: ${res.error.message}`);
    return;
  }

  const res: Result<unknown> = await db.from("project_overrides").upsert(
    {
      project_id: input.projectId,
      field: input.field,
      value,
      updated_by: input.actor ?? null,
    },
    { onConflict: "project_id,field" },
  );
  if (res.error) throw new Error(`setOverride: ${res.error.message}`);
}

/**
 * Set a due date, or clear it with null.
 *
 * The row is upserted rather than deleted when the date clears, because the
 * same row also carries the two hide flags — deleting it would silently unhide
 * fields the user hid.
 */
export async function setDueDate(
  db: Client_,
  input: { projectId: string; date: string | null; actor?: string | null },
): Promise<void> {
  if (!isProjectId(input.projectId)) throw new InvalidInputError(`bad project id: ${input.projectId}`);
  const date = input.date?.trim() || null;
  if (date !== null && !DATE_RE.test(date)) {
    throw new InvalidInputError(`due date must be YYYY-MM-DD: ${date}`);
  }
  const res: Result<unknown> = await db.from("project_settings").upsert(
    { project_id: input.projectId, due_date: date, updated_by: input.actor ?? null },
    { onConflict: "project_id" },
  );
  if (res.error) throw new Error(`setDueDate: ${res.error.message}`);
}

/** Hide or show one of the two hideable fields on one project. */
export async function setFieldHidden(
  db: Client_,
  input: { projectId: string; field: string; hidden: boolean; actor?: string | null },
): Promise<void> {
  if (!isProjectId(input.projectId)) throw new InvalidInputError(`bad project id: ${input.projectId}`);
  if (!isHideableField(input.field)) throw new InvalidInputError(`not a hideable field: ${input.field}`);
  if (typeof input.hidden !== "boolean") throw new InvalidInputError("hidden must be a boolean");

  const column = input.field === "due_date" ? "hide_due_date" : "hide_priority";
  const res: Result<unknown> = await db.from("project_settings").upsert(
    { project_id: input.projectId, [column]: input.hidden, updated_by: input.actor ?? null },
    { onConflict: "project_id" },
  );
  if (res.error) throw new Error(`setFieldHidden: ${res.error.message}`);
}

/**
 * Notes, newest first. `projectId` filters; passing null asks for the unsorted
 * pile specifically, which is why it is a distinct case from omitting it.
 */
export async function listNotes(
  db: Client_,
  opts: { projectId?: string | null } = {},
): Promise<ProjectNote[]> {
  let q = db.from("project_notes").select("id, project_id, body, author_email, created_at");
  if (opts.projectId === null) q = q.is("project_id", null);
  else if (opts.projectId !== undefined) {
    if (!isProjectId(opts.projectId)) throw new InvalidInputError(`bad project id: ${opts.projectId}`);
    q = q.eq("project_id", opts.projectId);
  }
  return unwrap<ProjectNote[]>(await q.order("created_at", { ascending: false }), "listNotes");
}

/**
 * Add a note. It starts UNSORTED unless a project is named.
 *
 * The Astro version auto-tagged by matching the note's text against project
 * names. That is not ported: a wrong guess files the note under a project
 * nobody will look at, and the note is then effectively lost. Unsorted is
 * visible; misfiled is not.
 */
export async function addNote(
  db: Client_,
  input: { body: string; projectId?: string | null; author?: string | null },
): Promise<void> {
  const body = input.body?.trim() ?? "";
  if (body === "") throw new InvalidInputError("a note needs some text");
  if (body.length > MAX_NOTE_LENGTH) {
    throw new InvalidInputError(`a note must be ${MAX_NOTE_LENGTH} characters or fewer`);
  }
  const projectId = input.projectId?.trim() || null;
  if (projectId !== null && !isProjectId(projectId)) {
    throw new InvalidInputError(`bad project id: ${projectId}`);
  }
  const res: Result<unknown> = await db.from("project_notes").insert({
    body,
    project_id: projectId,
    author_email: input.author ?? null,
  });
  if (res.error) throw new Error(`addNote: ${res.error.message}`);
}

/** Move a note to a project, or back to the unsorted pile with null. */
export async function assignNote(
  db: Client_,
  input: { id: string; projectId: string | null },
): Promise<void> {
  if (!input.id?.trim()) throw new InvalidInputError("note id is required");
  const projectId = input.projectId?.trim() || null;
  if (projectId !== null && !isProjectId(projectId)) {
    throw new InvalidInputError(`bad project id: ${projectId}`);
  }
  const res: Result<unknown> = await db
    .from("project_notes").update({ project_id: projectId }).eq("id", input.id);
  if (res.error) throw new Error(`assignNote: ${res.error.message}`);
}

/**
 * Delete a note.
 *
 * No author check here. RLS lets a member delete only a note whose
 * author_email matches their signed JWT claim, and an admin delete any — so a
 * check in this layer would be a second, weaker copy of a rule the database
 * already enforces against a caller who cannot forge the claim.
 */
export async function deleteNote(db: Client_, id: string): Promise<void> {
  if (!id?.trim()) throw new InvalidInputError("note id is required");
  const res: Result<unknown> = await db.from("project_notes").delete().eq("id", id);
  if (res.error) throw new Error(`deleteNote: ${res.error.message}`);
}

/**
 * A project with its manual layer applied. This is the `merge.ts` port, minus
 * `total_tokens` — that came from ManualData.token_log, which 0003 deliberately
 * does not carry (see the migration header).
 *
 * Kept structural rather than importing lib/os/types/project.ts, so this file
 * stays free of the filesystem side of the app and remains testable with plain
 * objects.
 */
export interface Mergeable {
  id: string;
  name: string;
  summary: string | null;
  repo: string | null;
  github: string | null;
  status: string;
  priority: string;
  next_step: string | null;
}

export type Merged<T extends Mergeable> = T & {
  due_date: string | null;
  /** true only when a due date exists AND is strictly before `today`. */
  overdue: boolean;
  hidden_fields: { due_date: boolean; priority: boolean };
  /** Which fields a human has overridden, so the UI can say the value is manual. */
  overridden: OverrideField[];
};

/**
 * Apply overrides and settings to a list of projects.
 *
 * `today` is a parameter, not `new Date()` read inside: overdue is a date
 * comparison, and a function that reads the clock cannot be tested at a
 * boundary. Callers pass the request's date.
 */
export function applyManualLayer<T extends Mergeable>(
  projects: T[],
  layer: ManualLayer,
  today: string,
): Merged<T>[] {
  return projects.map((p) => {
    const over = layer.overrides[p.id] ?? {};
    const settings = layer.settings[p.id];
    const due = settings?.due_date ?? null;

    // Only the string fields on Mergeable are overridable, and OVERRIDE_FIELDS
    // is checked against the same list the DB constrains — so a value here can
    // only land on a field that exists.
    const merged = { ...p } as T & Record<string, unknown>;
    const overridden: OverrideField[] = [];
    for (const field of OVERRIDE_FIELDS) {
      const value = over[field];
      if (value === undefined) continue;
      merged[field] = value;
      overridden.push(field);
    }

    return {
      ...(merged as T),
      due_date: due,
      overdue: due !== null && due < today,
      hidden_fields: {
        due_date: settings?.hide_due_date ?? false,
        priority: settings?.hide_priority ?? false,
      },
      overridden,
    };
  });
}
