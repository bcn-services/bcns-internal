/**
 * /graph — the knowledge graph over $OS_DIR, ported from graph.astro.
 *
 * The Astro page shipped a 3D force renderer as an island with the node list as
 * its no-JS fallback. Only the server half is ported here: the node list, the
 * counts and the FOCUS CLUSTER rail. The renderer is a client concern and
 * belongs to the visual pass; `/api/graph` already serves it the same data.
 *
 * ONE walk, reused: `buildTree` then `getGraph(root, dirs, tree)`, so the page
 * does not walk $OS_DIR twice. An unreadable root throws out of `buildTree`
 * rather than degrading to a successful empty graph — that is what puts the
 * banner on screen.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import OsNav from "@/components/OsNav";
import { osDir } from "@/lib/os/paths";
import { getSection, resolveSource } from "@/lib/os/sections";
import { buildTree } from "@/lib/os/osFiles";
import type { TreeNode } from "@/lib/os/osFiles";
import { getGraph, GRAPH_EXCLUDE_DIRS, focusClusters, fileHrefsFor } from "@/lib/os/graph";
import type { GraphData, GraphNode } from "@/lib/os/graph";

export const dynamic = "force-dynamic";

const SECTION_HREF = "/graph";

/**
 * ONE rule for kind -> display text, computed here and read by every consumer.
 * Written twice, it drifts — that is this codebase's most expensive bug family.
 */
const displayLabel = (node: GraphNode): string =>
  node.kind === "folder" ? `${node.label}/` : node.kind === "stub" ? `${node.label} (missing)` : node.label;

export default async function GraphPage({ searchParams }: { searchParams: { source?: string } }) {
  // Single-panel section: `?source=graph` is the only accepted value. Checked
  // before the tree walk so a bogus value costs nothing. Astro answered 400
  // here; a Next page can only answer notFound().
  if (resolveSource(SECTION_HREF, searchParams.source ?? null) === null) notFound();
  const section = getSection(SECTION_HREF);

  const root = osDir();
  let graph: GraphData = { nodes: [], edges: [] };
  let tree: TreeNode[] = [];
  let loadError = false;
  try {
    tree = await buildTree(root, GRAPH_EXCLUDE_DIRS);
    graph = await getGraph(root, GRAPH_EXCLUDE_DIRS, tree);
  } catch (err) {
    console.warn("[graph] getGraph failed:", err);
    loadError = true;
  }

  // Derived from the SAME graph object loaded above, never a second call. On
  // loadError `graph` is empty, so `clusters.total === 0` and the block omits.
  const clusters = focusClusters(graph);

  // A NEW map, never a mutation: getGraph freezes its result and a committed
  // test asserts a cache hit returns the identical object.
  const hrefs = fileHrefsFor(graph.nodes);

  const countOf = (kind: string) => graph.nodes.filter((n) => n.kind === kind).length;
  const linkEdges = graph.edges.filter((e) => e.kind === "link").length;
  const containsEdges = graph.edges.length - linkEdges;

  return (
    <main>
      <OsNav current={SECTION_HREF} />
      <h1>{section.title}</h1>

      {loadError ? (
        <p role="alert">Could not read $OS_DIR.</p>
      ) : (
        <p>
          Graph of $OS_DIR: {countOf("note")} notes, {countOf("folder")} folders and{" "}
          {countOf("stub")} missing link targets, connected by {linkEdges} links and{" "}
          {containsEdges} folder-containment edges.
        </p>
      )}

      {clusters.total > 0 && (
        <section aria-labelledby="focus-clusters">
          <h2 id="focus-clusters">Focus clusters</h2>
          <p>
            {clusters.attributed} attributed · {clusters.unattributed} unattributed
          </p>
          <ul>
            {clusters.clusters.map((c) => (
              <li key={c.project}>
                {c.project} — {c.count} ({c.pct}%)
              </li>
            ))}
          </ul>
        </section>
      )}

      <details>
        <summary>{graph.nodes.length} nodes</summary>
        <ul>
          {graph.nodes.map((node) => {
            const href = hrefs.get(node.id) ?? null;
            return (
              <li key={node.id}>
                {href ? <Link href={href}>{displayLabel(node)}</Link> : displayLabel(node)}
              </li>
            );
          })}
        </ul>
      </details>

      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
