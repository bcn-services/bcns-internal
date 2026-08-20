/**
 * GET /api/graph — the graph over $OS_DIR: `kind:'link'` edges (wikilinks +
 * markdown `[x](y.md)` links) and `kind:'contains'` edges (parent folder ->
 * child, derived from each path at request time). Cached in memory and
 * rebuilt only when a source file's mtime changes (see getGraph()).
 * Strictly read-only: no request body, no write path.
 *
 * Ported verbatim from project-dashboard's src/pages/api/graph.ts.
 */
import { osDir } from "@/lib/os/paths";
import { getGraph } from "@/lib/os/graph";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    // osDir() is read at call time (not module load), so OS_DIR can repoint
    // the root at a clone without a restart.
    const { nodes, edges } = await getGraph(osDir());
    return Response.json({ ok: true, nodes, edges });
  } catch (err) {
    console.warn("[api/graph] getGraph failed:", err);
    return Response.json({ ok: false, error: "Failed to build the graph." }, { status: 500 });
  }
}
