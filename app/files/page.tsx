/**
 * /files — the read-only browser over $OS_DIR, ported from files.astro plus the
 * SkillsPanel / PlansPanel it still routes to via `?source=`.
 *
 * `?source=` is validated by `resolveSource`, the one reachability guard, so an
 * unlisted value is a hard miss rather than a silent fall-through to the default
 * panel. Astro answered that with a 400; a Next page cannot set an arbitrary
 * status, so this calls `notFound()` (404). That is the one behavioural
 * deviation in this file.
 *
 * `?file=` never becomes a path by hand. Browse mode runs it through
 * `resolveNotePath` — the app's single traversal/symlink/hidden-segment guard.
 * Skills and plans mode look it up in the allowlist their lib built alongside
 * the rows it linked, so "what the page links" and "what the page will serve"
 * stay one decision.
 *
 * NOT ported from files.astro: the stat tiles, the kind chips and the
 * recently-touched table. Those live in src/lib/filesBrowse.ts, which imports
 * `relativeTime` from recentLogs.ts — out of scope for this job.
 */
import { join } from "path";
import Link from "next/link";
import { notFound } from "next/navigation";
import OsNav from "@/components/OsNav";
import { osDir } from "@/lib/os/paths";
import { getSection, resolveSource, withParam } from "@/lib/os/sections";
import { buildTree, collectSlugs, readNote, resolveNotePath } from "@/lib/os/osFiles";
import type { NoteResult, TreeNode } from "@/lib/os/osFiles";
import { listSkills } from "@/lib/os/skillsFiles";
import { listProjectPlans } from "@/lib/os/plansFiles";

export const dynamic = "force-dynamic";

const SECTION_HREF = "/files";
/** The only extension the viewer can render. Everything else lists but does not open. */
const VIEWABLE_EXTENSIONS = [".md"];

function Note({ note, error }: { note: NoteResult | null; error: string | null }) {
  if (error) return <p role="alert">{error}</p>;
  if (!note) return null;
  return (
    <article>
      {note.frontmatterError && <p role="alert">{note.frontmatterError}</p>}
      {/* readNote() already stripped raw HTML and rewrote links; this is the
          sanitized output, not user input. */}
      <div dangerouslySetInnerHTML={{ __html: note.html }} />
    </article>
  );
}

function Tree({ nodes, fileParam }: { nodes: TreeNode[]; fileParam: string | null }) {
  return (
    <ul>
      {nodes.map((node) =>
        node.type === "dir" ? (
          <li key={node.relPath}>
            {node.name}/
            <Tree nodes={node.children} fileParam={fileParam} />
          </li>
        ) : (
          <li key={node.relPath}>
            {VIEWABLE_EXTENSIONS.some((e) => node.relPath.toLowerCase().endsWith(e)) ? (
              <Link
                href={withParam(SECTION_HREF, "file", node.relPath)}
                aria-current={node.relPath === fileParam ? "true" : undefined}
              >
                {node.name}
              </Link>
            ) : (
              node.name
            )}
          </li>
        ),
      )}
    </ul>
  );
}

/** Skills and plans both render a flat allowlisted list plus warnings. */
async function AllowlistPanel({
  blurb,
  rows,
  warnings,
  allowlist,
  fileParam,
  loadError,
}: {
  blurb: string;
  rows: { label: string; relPath: string; description?: string }[];
  warnings: { label: string; reason: string }[];
  allowlist: Map<string, string>;
  fileParam: string | null;
  loadError: boolean;
}) {
  const absPath = fileParam ? allowlist.get(fileParam) : undefined;
  const note = absPath
    ? await readNote(absPath, { slugMap: new Map(), hrefBase: SECTION_HREF })
    : null;
  // Not in the allowlist means not linked, so it is not servable either.
  const noteError = fileParam && !absPath ? "That file is not available here." : null;

  return (
    <>
      <p>{blurb}</p>
      {loadError && <p role="alert">Failed to load this list.</p>}
      {warnings.length > 0 && (
        <details>
          <summary>
            {warnings.length} entr{warnings.length === 1 ? "y" : "ies"} skipped
          </summary>
          <ul>
            {warnings.map((w) => (
              <li key={w.label}>
                {w.label} — {w.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ul>
        {rows.map((r) => (
          <li key={r.relPath}>
            <Link
              href={withParam(SECTION_HREF, "file", r.relPath)}
              aria-current={r.relPath === fileParam ? "true" : undefined}
            >
              {r.label}
            </Link>
            {r.description ? ` — ${r.description}` : ""}
          </li>
        ))}
      </ul>
      <Note note={note} error={noteError} />
    </>
  );
}

export default async function FilesPage({
  searchParams,
}: {
  searchParams: { source?: string; file?: string };
}) {
  const section = getSection(SECTION_HREF);
  const source = resolveSource(SECTION_HREF, searchParams.source ?? null);
  if (source === null) notFound();
  const fileParam = searchParams.file ?? null;

  let body: React.ReactNode;

  if (source === "skills") {
    let skills = { tree: [] as { name: string; relPath: string }[], descriptions: new Map<string, string>(), allowlist: new Map<string, string>(), warnings: [] as { folder: string; reason: string }[] };
    let loadError = false;
    try {
      skills = await listSkills(join(osDir(), "skills"));
    } catch (err) {
      console.warn("[files] listSkills failed:", err);
      loadError = true;
    }
    body = (
      <AllowlistPanel
        blurb="Read-only browser for $OS_DIR/skills."
        rows={skills.tree.map((f) => ({
          label: f.name,
          relPath: f.relPath,
          description: skills.descriptions.get(f.relPath),
        }))}
        warnings={skills.warnings.map((w) => ({ label: w.folder, reason: w.reason }))}
        allowlist={skills.allowlist}
        fileParam={fileParam}
        loadError={loadError}
      />
    );
  } else if (source === "plans") {
    let plans = { tree: [] as { name: string; children: { name: string; relPath: string }[] }[], allowlist: new Map<string, string>(), warnings: [] as { project: string; reason: string }[] };
    let loadError = false;
    try {
      plans = await listProjectPlans(join(osDir(), "projects"));
    } catch (err) {
      console.warn("[files] listProjectPlans failed:", err);
      loadError = true;
    }
    body = (
      <AllowlistPanel
        blurb="PLAN.md / PROGRESS.md from each project's own repo."
        rows={plans.tree.flatMap((d) =>
          d.children.map((f) => ({ label: `${d.name}/${f.name}`, relPath: f.relPath })),
        )}
        warnings={plans.warnings.map((w) => ({ label: w.project, reason: w.reason }))}
        allowlist={plans.allowlist}
        fileParam={fileParam}
        loadError={loadError}
      />
    );
  } else {
    // Browse: the real $OS_DIR, top-level folders and all, walked live off disk.
    // `[]` — no content filter. `null` — every file, not just markdown, because
    // a mirror that drops a real top-level folder is not a mirror.
    const root = osDir();
    let tree: TreeNode[] = [];
    let loadError = false;
    try {
      tree = await buildTree(root, [], null);
    } catch (err) {
      console.warn("[files] buildTree failed:", err);
      loadError = true;
    }

    let note: NoteResult | null = null;
    let noteError: string | null = null;
    if (fileParam) {
      const resolved = resolveNotePath(root, fileParam, [], VIEWABLE_EXTENSIONS);
      if (!resolved.ok) {
        noteError = resolved.reason;
      } else {
        try {
          note = await readNote(resolved.absPath, {
            slugMap: collectSlugs(tree),
            hrefBase: SECTION_HREF,
          });
        } catch (err) {
          console.warn("[files] readNote failed:", err);
          noteError = "Failed to load this note.";
        }
      }
    }

    body = (
      <>
        <p>Read-only over $OS_DIR.</p>
        {loadError ? <p role="alert">Could not read $OS_DIR.</p> : <Tree nodes={tree} fileParam={fileParam} />}
        <Note note={note} error={noteError} />
      </>
    );
  }

  return (
    <main>
      <OsNav current={SECTION_HREF} />
      <h1>{section.title}</h1>
      <ul>
        {section.panels.map((p) => (
          <li key={p.id}>
            {p.id === source ? (
              <span aria-current="page">{p.label}</span>
            ) : (
              <Link href={withParam(SECTION_HREF, "source", p.id)}>{p.label}</Link>
            )}
          </li>
        ))}
      </ul>
      {body}
      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
