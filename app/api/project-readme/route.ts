/**
 * GET /api/project-readme?slug=<id> — the rendered
 * `$OS_DIR/projects/<id>/README.md` for one project's inline expansion.
 * Read-only; no write path.
 *
 * The slug is never touched by hand: it becomes the relative path
 * `<slug>/README.md` and goes straight through `resolveNotePath`, the app's one
 * path-traversal guard (absolute paths, `..` escapes, hidden segments, non-`.md`
 * extensions and symlinks out of root are all its job, not this file's).
 *
 * Ported verbatim from project-dashboard's src/pages/api/project-readme.ts.
 */
import { join } from "path";
import { expandTilde, osDir } from "@/lib/os/paths";
import { resolveNotePath, readNote } from "@/lib/os/osFiles";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) {
    return Response.json({ ok: false, error: "Missing slug parameter." }, { status: 400 });
  }

  // Same root resolution as `getProjects()` in lib/os/projects.ts — the ids it
  // hands the cards are directory names under exactly this folder, so an
  // OS_PROJECTS_DIR override must not leave the two disagreeing.
  const root = expandTilde(process.env.OS_PROJECTS_DIR ?? join(osDir(), "projects"));
  const resolved = resolveNotePath(root, `${slug}/README.md`);
  if (!resolved.ok) {
    return Response.json({ ok: false, error: resolved.reason }, { status: resolved.status });
  }

  // Empty slug map: building the whole tree per request is not worth it, and an
  // unresolved `[[target]]` degrades to literal text rather than a dead link.
  const note = await readNote(resolved.absPath, { slugMap: new Map(), hrefBase: "/files" });
  return Response.json({ ok: true, html: note.html });
}
