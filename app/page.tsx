/**
 * page.tsx — the brain. The front door is the knowledge graph over $OS_DIR,
 * with the morning board underneath it.
 *
 * The graph moved here from /graph because it is the one surface that answers
 * "what does this company know" rather than "what is on my plate", and because
 * it is how anyone without os cloned reaches knowledge/audience/ and
 * knowledge/library/bcns/ — a node click opens the file in a popup.
 *
 * ONE walk, reused: `buildTree` then `getGraph(root, dirs, tree)`, so the page
 * does not walk $OS_DIR twice. An unreadable root throws out of `buildTree`
 * rather than degrading to a successful empty graph — that is what puts the
 * banner on screen instead of a silently empty sky.
 *
 * The node list below the canvas is not decoration: it is the whole page for a
 * reader with no JavaScript or no WebGL, and it is what a screen reader walks.
 */
import { osDir } from "@/lib/os/paths";
import { buildTree } from "@/lib/os/osFiles";
import type { TreeNode } from "@/lib/os/osFiles";
import { getGraph, GRAPH_EXCLUDE_DIRS, focusClusters, fileHrefsFor } from "@/lib/os/graph";
import type { GraphData, GraphNode } from "@/lib/os/graph";
import Link from "next/link";
import BrainGraph from "./brain-graph";
import type { BrainNode } from "./brain-graph";
import Today from "./today";
import BriefingCard from "./briefing-card";

export const dynamic = "force-dynamic";

/**
 * ONE rule for kind -> display text, computed here and read by the canvas
 * tooltip and the list alike. Written twice, it drifts — that is this
 * codebase's most expensive bug family.
 */
const displayLabel = (node: GraphNode): string =>
  node.kind === "folder" ? `${node.label}/` : node.kind === "stub" ? `${node.label} (missing)` : node.label;

export default async function BrainPage() {
  const root = osDir();
  let graph: GraphData = { nodes: [], edges: [] };
  let tree: TreeNode[] = [];
  let loadError = false;
  try {
    tree = await buildTree(root, GRAPH_EXCLUDE_DIRS);
    graph = await getGraph(root, GRAPH_EXCLUDE_DIRS, tree);
  } catch (err) {
    console.warn("[brain] getGraph failed:", err);
    loadError = true;
  }

  // Derived from the SAME graph object loaded above, never a second call. On
  // loadError `graph` is empty, so `clusters.total === 0` and the block omits.
  const clusters = focusClusters(graph);

  // A NEW array, never a mutation: getGraph freezes its result and a committed
  // test asserts a cache hit returns the identical object.
  const nodes: BrainNode[] = graph.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    display: displayLabel(n),
    relPath: n.relPath ?? null,
  }));
  const edges = graph.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

  // The fallback list keeps real links even though the canvas opens a popup:
  // with no JavaScript there is no popup, and an unlinked list of filenames is
  // a table of contents for a book the reader cannot open. /files is unlinked
  // from the nav but still served, and it is also where a wikilink inside a
  // popup lands.
  const hrefs = fileHrefsFor(graph.nodes);

  const countOf = (kind: string) => graph.nodes.filter((n) => n.kind === kind).length;
  const linkEdges = graph.edges.filter((e) => e.kind === "link").length;
  const containsEdges = graph.edges.length - linkEdges;

  return (
    <main>
      <h1>Brain</h1>

      {loadError ? (
        <p role="alert">Could not read $OS_DIR.</p>
      ) : (
        <>
          <BrainGraph nodes={nodes} edges={edges} />
          {/* A fact about what is drawn, not a caption — it has to keep matching
              the canvas aria-label in brain-graph.tsx. Change both together. */}
          <p>
            {countOf("note")} notes, {countOf("folder")} folders and {countOf("stub")} missing
            link targets, connected by {linkEdges} links and {containsEdges} folder edges.
          </p>
        </>
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
          {nodes.map((node) => {
            const href = hrefs.get(node.id) ?? null;
            return (
              <li key={node.id}>{href ? <Link href={href}>{node.display}</Link> : node.display}</li>
            );
          })}
        </ul>
      </details>

      {/* Above the board: what the automation has to say this morning. It is a
          server component that never waits for an agent — see briefing-card.tsx. */}
      <BriefingCard />

      <Today />
    </main>
  );
}
