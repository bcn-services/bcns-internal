/**
 * GET /api/os/note?file=<relPath> — one markdown file from $OS_DIR, rendered.
 *
 * This is what the brain graph's node popup reads. It exists because clicking a
 * star should open the file where you are, not navigate away to /files: business
 * employees will not have os cloned, and the graph is how they reach
 * knowledge/audience/ and knowledge/library/bcns/.
 *
 * The guard is `resolveNotePath` — the app's single traversal, symlink and
 * hidden-segment check, shared with /files and with the tree walker. There is
 * deliberately no second check here: a past bug served ~1000 hidden .md files
 * precisely because two places decided one thing.
 *
 * Strictly read-only. No request body, no write path.
 */
import { osDir } from "@/lib/os/paths";
import { buildTree, collectSlugs, readNote, resolveNotePath } from "@/lib/os/osFiles";

export const dynamic = "force-dynamic";

/** The only extension the viewer can render, same as /files. */
const VIEWABLE_EXTENSIONS = [".md"];

export async function GET(request: Request): Promise<Response> {
  const file = new URL(request.url).searchParams.get("file");
  if (!file) return Response.json({ ok: false, error: "Missing ?file=" }, { status: 400 });

  // osDir() at call time, never at module load, so OS_DIR can repoint at a
  // clone without a restart.
  const root = osDir();
  const resolved = resolveNotePath(root, file, [], VIEWABLE_EXTENSIONS);
  if (!resolved.ok) return Response.json({ ok: false, error: resolved.reason }, { status: resolved.status });

  try {
    // The slug map is what turns [[wikilinks]] in the body into real hrefs.
    // Built from the same walk /files uses so a link resolves identically in
    // the popup and on the page.
    const note = await readNote(resolved.absPath, {
      slugMap: collectSlugs(await buildTree(root, [])),
      hrefBase: "/files",
    });
    return Response.json({
      ok: true,
      relPath: file,
      html: note.html,
      frontmatterError: note.frontmatterError,
    });
  } catch (err) {
    console.warn("[api/os/note] read failed:", file, err);
    return Response.json({ ok: false, error: "Could not read that file." }, { status: 500 });
  }
}
