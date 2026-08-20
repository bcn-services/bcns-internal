import { readFile, stat } from 'fs/promises';
import { basename, join, posix } from 'path';
import {
  buildTree,
  collectSlugs,
  collectLinkTargets,
  listFiles,
  normalizeWikilinkTarget,
  parseFrontmatter,
} from './osFiles';
import type { TreeFile, TreeNode } from './osFiles';
import { getSection, withParam } from './sections';

/**
 * The Files section's own path — read out of SECTIONS rather than spelled, so
 * the brain's node links follow the section if it is ever re-routed. Not
 * `hrefFor('/files', <panel>)` any more: `/files` is one browse surface now,
 * and every `?source=` is legacy.
 */
const FILES_HREF = getSection('/files').href;

/** Same exclusion list /knowledge uses — kept as one constant so the graph
 * builder and any note-resolution guard the /graph page runs agree on what's
 * in-bounds by construction (this repo has shipped lister-vs-guard drift on
 * exactly this three times already). */
export const GRAPH_EXCLUDE_DIRS = ['library', 'raw'];

export interface GraphNode {
  /**
   * A note's id is always its file relPath (always ends `.md`); a folder's id
   * is always its directory relPath, and the tree root's is `ROOT_ID`. Those
   * three spaces are disjoint BY CONSTRUCTION: one path cannot be both a file
   * and a directory, and no relPath is ever `.` (they're built from readdir
   * entry names, and `.` is not a legal entry name). A stub's id is
   * `stub:<slug>` — normalizeWikilinkTarget already strips a trailing `.md`
   * from the slug, so it never ends in `.md` in practice, but a *directory*
   * literally named `stub:foo` is legal, so stub ids are minted against
   * `usedIds` rather than assumed disjoint.
   */
  id: string;
  /** Basename without `.md` for a note; the directory name for a folder; the raw slug for a stub. */
  label: string;
  kind: 'note' | 'folder' | 'stub';
  /**
   * Clickable target for a note; always null for a folder or a stub — a stub
   * doesn't exist on disk, and `resolveNotePath` only accepts `.md`, so a
   * `?file=` link to a directory would 400.
   */
  relPath: string | null;
  /** Top-level path segment ('knowledge' | 'projects' | 'skills' | ...), '' for root files, top-level folders, the root, or stubs. */
  dir: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /**
   * `link` — a wikilink or markdown reference somebody actually wrote in a
   * file. `contains` — derived at request time from the path alone (parent
   * folder → child), present in no file on disk.
   */
  kind: 'link' | 'contains';
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Id of the synthetic node for the tree root itself. `posix.dirname` already
 * returns exactly this for a top-level path, so it needs no special case at
 * the point edges are minted.
 */
export const ROOT_ID = '.';

function topLevelDir(relPath: string): string {
  const slash = relPath.indexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

/**
 * Turns a markdown link target (already filtered to a `.md` path by
 * `collectLinkTargets`) into a root-relative path, resolved against the
 * directory of the file that contains the link — 23 of the 47 such links in
 * ~/os are relative-with-directory (`../bcns/README.md`, `./SKILL.md`), so
 * resolution is mandatory, not optional. A leading `/` means root-relative
 * (this is a note tree, not a filesystem). Returns null when the result
 * escapes the root, so `[x](../../../etc/passwd.md)` yields neither an edge
 * nor a stub.
 */
export function resolveMarkdownTarget(fromRelPath: string, target: string): string | null {
  const resolved = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromRelPath), target));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

/**
 * Builds nodes + edges from an already-enumerated file list (no directory
 * walk of its own). `getGraph` relies on this: it walks and `stat`s once,
 * drops any file whose `stat` failed, and passes that exact surviving list
 * both into the cache key and in here — so the key and the graph content
 * can never disagree. `buildGraph` (below) is the plain "walk fresh, build
 * fresh" entry point that calls this with its own freshly-listed files.
 *
 * Emits two edge kinds: `link` (a reference someone wrote in a file) and
 * `contains` (parent folder -> child, derived from the relPath alone). The
 * containment half is pure string work over the same `files` array — it adds
 * no I/O, so nothing is read from or written to disk for it.
 *
 * Iterative only — one pass over each file's own outgoing links, no
 * traversal of the resulting link graph. A cycle like `[[a]]`→`[[b]]`→`[[a]]`
 * is just two independent edges recorded while processing `a` and `b`
 * separately; there is no recursive follow-the-link step here, so a cycle
 * cannot hang this function.
 */
async function buildGraphFromFiles(root: string, files: TreeFile[]): Promise<GraphData> {
  // `files` (TreeFile[]) is structurally a flat list of TreeNode's `file`
  // variant, so this is the SAME slug map `collectSlugs` builds for the
  // viewer (full relPath-without-extension and bare basename both resolve)
  // — a link that resolves in the viewer resolves here too.
  const slugMap = collectSlugs(files);

  // Exact root-relative paths of the real notes — what a *markdown* link
  // resolves against. Deliberately NOT `slugMap`: that map also keys bare
  // basenames, and 12 project READMEs share the basename `README`, so a
  // root-level `[x](README.md)` would silently bind to whichever README came
  // first in tree order. A markdown target is already a path, so it gets a
  // path lookup — strict, no basename fallback. (Measured on today's tree:
  // strict and fallback give identical results, so the fallback would buy
  // nothing and only risk wrong edges.)
  const notePaths = new Set(files.map((file) => file.relPath));

  const nodes: GraphNode[] = files.map((file) => ({
    id: file.relPath,
    label: basename(file.relPath).replace(/\.md$/i, ''),
    kind: 'note',
    relPath: file.relPath,
    dir: topLevelDir(file.relPath),
  }));

  // Every ancestor directory of every file, derived from the SAME `files`
  // array that minted the note nodes above. That is the whole point: ONE
  // expression produces both the folder node set and the set of folders a
  // containment edge may name, so an edge can never point at a folder the
  // node walk excluded (a hidden dir, an excluded dir). Deriving from the
  // TreeDir walk instead would also break the other direction — `getGraph`
  // drops a file whose `stat` failed from `files` but not from the tree, so a
  // folder node could outlive its last surviving child.
  const folderIds = new Set<string>();
  for (const file of files) {
    const parts = file.relPath.split('/');
    for (let i = 1; i < parts.length; i++) folderIds.add(parts.slice(0, i).join('/'));
  }

  const stubs = new Map<string, GraphNode>(); // slug -> shared stub node
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  // Note ids are file relPaths, folder ids are directory relPaths, and the
  // root is `.` — disjoint by construction (see GraphNode.id). Stub ids are
  // NOT: a real file named `stub:note.md` and a `[[note.md.md]]` link both
  // mint the id `stub:note.md` (and a *directory* named `stub:foo` is legal
  // too), and d3's forceLink last-wins rather than throwing, so two nodes
  // silently merge (reproduced). Minting every stub id against the ids
  // already taken — notes, folders AND the root, all before the first stub
  // can be created below — makes them disjoint outright, with no assumption
  // about what a filename can contain.
  const usedIds = new Set(notePaths); // note ids ARE relPaths, so this is the same set
  usedIds.add(ROOT_ID);
  for (const folderId of folderIds) usedIds.add(folderId);

  function addEdge(source: string, target: string, kind: GraphEdge['kind']): void {
    if (source === target) return; // no self-edges
    // NUL-separated: a relPath may contain a space, so a space separator makes
    // `a.md` -> `b c` and `a.md b` -> `c` the same key. No path can contain NUL.
    const key = `${source}\u0000${target}`;
    if (edgeKeys.has(key)) return; // a file linking the same note twice is one edge
    edgeKeys.add(key);
    edges.push({ source, target, kind });
  }

  function stubFor(slug: string): GraphNode {
    let stub = stubs.get(slug);
    if (!stub) {
      let id = `stub:${slug}`;
      while (usedIds.has(id)) id += '!';
      usedIds.add(id);
      stub = { id, label: slug, kind: 'stub', relPath: null, dir: '' };
      stubs.set(slug, stub);
    }
    return stub;
  }

  // ponytail: unbounded Promise.all fan-out — 125 files / ~40ms today, ceiling
  // is the process file-descriptor limit (~10k on macOS). Chunk to ~32
  // concurrent only if ~/os ever grows to thousands of notes.
  await Promise.all(
    files.map(async (file) => {
      const absPath = join(root, file.relPath);
      let raw: string;
      try {
        raw = await readFile(absPath, 'utf-8');
      } catch (err) {
        console.warn('[graph] read failed, skipping:', absPath, err);
        return;
      }

      const { body } = parseFrontmatter(raw, absPath);

      // Both link kinds go through this ONE resolve-or-stub step: whatever
      // decides a target becomes an edge is the same code that decides it
      // becomes a node, so "every edge endpoint exists in nodes" holds by
      // construction, and `addEdge`'s dedup makes a file that links the same
      // note as BOTH a wikilink and a markdown link exactly one edge.
      for (const link of collectLinkTargets(body)) {
        if (link.kind === 'wikilink') {
          const slug = normalizeWikilinkTarget(link.target);
          // `[[   ]]` and `[[.md]]` normalize to '' — there is no target, and a
          // blank-labelled stub node is worse than no node at all.
          if (!slug) continue;
          const resolvedRelPath = slugMap.get(slug);
          // Resolved -> a real edge to that file. Unresolved -> get-or-create
          // ONE shared stub node per missing slug, so N files linking the same
          // missing target still produce one node.
          addEdge(file.relPath, resolvedRelPath ?? stubFor(slug).id, 'link');
          continue;
        }

        const resolved = resolveMarkdownTarget(file.relPath, link.target);
        if (!resolved) continue; // escapes the root — no edge, no stub
        // Stubs are keyed WITHOUT the extension, exactly like wikilink stubs.
        // That collapses `[[foo]]` and `[foo](foo.md)` onto ONE stub only at
        // the tree root: a markdown target is resolved against the linking
        // file's directory first, so from `sub/deep.md` the two key
        // `stub:nope` and `stub:sub/nope` — different targets, correctly
        // different stubs (pinned by a nested fixture in
        // tests/graph-markdown-links.test.ts).
        const slug = resolved.replace(/\.md$/i, '');
        if (!slug) continue;
        addEdge(file.relPath, notePaths.has(resolved) ? resolved : stubFor(slug).id, 'link');
      }
    })
  );

  // One node per derived folder id, plus the tree root itself. Pure string
  // work — no extra stat, no extra readFile, no second walk.
  const folderNodes: GraphNode[] = [...folderIds].sort().map((id) => ({
    id,
    label: basename(id),
    kind: 'folder',
    relPath: null,
    dir: topLevelDir(id),
  }));
  const rootNode: GraphNode = {
    id: ROOT_ID,
    label: basename(root) || '/',
    kind: 'folder',
    relPath: null,
    dir: '',
  };

  // Parent is the SOURCE, so an edge reads "knowledge contains
  // knowledge/foo.md". `posix.dirname` yields `.` — the root's id — for a
  // top-level path, so the root needs no special case here.
  //
  // INVARIANT: every node except the root and except stubs appears exactly
  // once as the `target` of a `contains` edge (each id is visited once, and
  // `addEdge` cannot drop it: parent !== child, and no other edge can share
  // its key). Stubs get none — they have no path and don't exist on disk, and
  // a stub is never isolated anyway, since it only exists because a `link`
  // edge already points at it. Every endpoint is in `nodes`: the parent of a
  // note id or a folder id is either the root or itself a member of
  // `folderIds`, because a prefix of a prefix is a prefix.
  for (const node of [...nodes, ...folderNodes]) addEdge(posix.dirname(node.id), node.id, 'contains');

  // Frozen in place, NOT copied: `getGraph` hands the same object back on a
  // cache hit and callers rely on that identity, so a copy would break the
  // cache contract while a mutating caller would poison the cache for the whole
  // process. Freezing keeps identity and removes the hazard.
  // Note nodes stay FIRST and in their original order — the folder nodes, the
  // root and the stubs are appended, never interleaved.
  const allNodes = [...nodes, rootNode, ...folderNodes, ...stubs.values()];
  allNodes.forEach((node) => Object.freeze(node));
  edges.forEach((edge) => Object.freeze(edge));
  Object.freeze(allNodes);
  Object.freeze(edges);
  return Object.freeze({ nodes: allNodes, edges });
}

/**
 * Pure, uncached: walks `root` fresh and builds the graph. Exported
 * separately from `getGraph` so a timing test can measure the real build
 * cost directly, without ever hitting the cache.
 */
export async function buildGraph(root: string, excludeDirs: string[] = GRAPH_EXCLUDE_DIRS): Promise<GraphData> {
  const tree = await buildTree(root, excludeDirs);
  return buildGraphFromFiles(root, listFiles(tree));
}

export interface ProjectCluster {
  project: string;
  count: number;
  /** Share of the LARGEST cluster (0-100, rounded), not share of total. */
  pct: number;
}

export interface FocusClusters {
  clusters: ProjectCluster[];
  attributed: number;
  unattributed: number;
  total: number;
}

/**
 * The ONE path→project rule in the app: a path belongs to project P iff it
 * sits INSIDE `projects/<P>/` — i.e. it splits into segments where `segs[0]`
 * is `projects`, there are at least 3 of them, and `segs[1]` is non-empty.
 * Everything else returns null.
 *
 * The `length >= 3` clause is the whole rule and is not an off-by-one: it is
 * what makes `projects/os` (the folder node itself) score nothing while
 * `projects/os/README.md` scores, and it is why `projects/os` cannot swallow
 * `projects/os-evals` — the segment split compares whole segments, never a
 * string prefix. `projects/_TEMPLATE.md` and `projects/INDEX.md` fall out here
 * too (2 segments), which is correct: they describe the projects folder, they
 * do not belong to a project.
 *
 * Extracted so the Brain's FOCUS CLUSTER rail and the Files page's RECENTLY
 * TOUCHED table attribute a file identically. Two copies of this would let the
 * two surfaces disagree about which project a file belongs to, which is the
 * kind of drift nobody notices until the counts are compared by hand.
 *
 * Safe on a stub id (`stub:<slug>`) — `segs[0]` can never equal `projects`.
 */
export function projectOf(relPath: string): string | null {
  const segs = relPath.split('/');
  return segs[0] === 'projects' && segs.length >= 3 && segs[1] ? segs[1] : null;
}

/**
 * Groups graph nodes by ~/os project for the Brain view's FOCUS CLUSTER rail.
 * Pure: no I/O, derives every project name from the nodes themselves — never
 * a hardcoded list, so a project with no attributed node cannot appear.
 *
 * Attribution is `projectOf` above — the same rule the Files page's RECENTLY
 * TOUCHED table uses, so the two surfaces cannot disagree about which project
 * a file belongs to. Everything it returns null for is unattributed BY
 * CONSTRUCTION: the root ('.'), the bare 'projects' folder, every
 * 'projects/<name>' folder node itself, 'projects/_TEMPLATE.md',
 * 'projects/INDEX.md', every skills/** and knowledge/** node, and every stub.
 */
export function focusClusters(graph: GraphData): FocusClusters {
  const counts = new Map<string, number>();
  let attributed = 0;
  for (const node of graph.nodes) {
    const project = projectOf(node.id);
    if (project) {
      counts.set(project, (counts.get(project) ?? 0) + 1);
      attributed++;
    }
  }
  const total = graph.nodes.length;
  const unattributed = total - attributed;

  const maxCount = Math.max(0, ...counts.values());
  if (maxCount === 0) return { clusters: [], attributed: 0, unattributed: total, total };

  // A fresh array — graph.nodes (and any structure derived from it here) is
  // never mutated or sorted in place; getGraph hands back the same frozen
  // object on a cache hit and callers rely on that identity.
  const clusters: ProjectCluster[] = [...counts.entries()]
    .map(([project, count]) => ({ project, count, pct: Math.round((count / maxCount) * 100) }))
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project, 'en'));

  return { clusters, attributed, unattributed, total };
}

interface CacheEntry {
  key: string;
  graph: GraphData;
}

// Keyed by root (not a single slot) so alternating roots across calls/tests
// don't thrash one cache entry, but capped so it can't grow without bound.
// ponytail: FIFO, not LRU — this app has exactly one root, so the cap only
// exists to stop a test process (or a future multi-root caller) retaining
// every graph it ever built. Swap in an LRU if roots ever really alternate.
const MAX_CACHED_ROOTS = 2;
const caches = new Map<string, CacheEntry>();

/**
 * Cached wrapper around `buildGraphFromFiles`. The cache key is the sorted
 * `relPath:mtimeMs:size` of every currently-live file — a deleted file is
 * simply absent from the new key (no stale mtime to compare against), a new or
 * modified file changes it, so one mechanism covers all three cases. `size` is
 * in the key because `rsync -t` and `tar -p` restore content while *preserving*
 * mtime, which an mtime-only key would serve stale indefinitely. The exact same
 * stat'd file list that produces the key is what gets built, so the key and the
 * graph content can never disagree — a file whose `stat` races a deletion
 * mid-walk is dropped from BOTH.
 *
 * `tree` lets a caller that already walked `root` (with the same exclusions)
 * hand that walk in rather than paying for a second one — `/graph` needs the
 * same tree for its file viewer, so a `?file=` request used to walk twice.
 */
export async function getGraph(
  root: string,
  excludeDirs: string[] = GRAPH_EXCLUDE_DIRS,
  tree?: TreeNode[]
): Promise<GraphData> {
  const files = listFiles(tree ?? (await buildTree(root, excludeDirs)));

  const statted = await Promise.all(
    files.map(async (file) => {
      try {
        const s = await stat(join(root, file.relPath));
        return { file, mtimeMs: s.mtimeMs, size: s.size };
      } catch (err) {
        console.warn('[graph] stat failed, dropping from graph:', file.relPath, err);
        return null;
      }
    })
  );
  const live = statted.filter(
    (entry): entry is { file: TreeFile; mtimeMs: number; size: number } => entry !== null
  );
  const key = live
    .map(({ file, mtimeMs, size }) => `${file.relPath}:${mtimeMs}:${size}`)
    .sort()
    .join('|');

  const cached = caches.get(root);
  if (cached && cached.key === key) return cached.graph; // same object — identity holds

  const graph = await buildGraphFromFiles(
    root,
    live.map(({ file }) => file)
  );
  if (!caches.has(root) && caches.size >= MAX_CACHED_ROOTS) {
    const oldest = caches.keys().next().value;
    if (oldest !== undefined) caches.delete(oldest);
  }
  caches.set(root, { key, graph }); // only after a full, successful build
  return graph;
}

/**
 * A graph node's id -> the `/files` URL that opens it, or no entry when the
 * node has no file page (folders and stubs).
 *
 * THE table — and as of the `/files` restructure it is a one-liner, which is
 * the point. Node ids are relPaths rooted at `$OS_DIR` and `/files` is now a
 * single browse surface rooted at that same directory, so the mapping is the
 * identity: `?file=` takes the node's own relPath and opens the file the user
 * actually clicked.
 *
 * What this replaced, and why none of it is needed any more: `/files` used to
 * be five panels with five DIFFERENT roots, so this function had to re-root
 * every path per top-level directory (`knowledge/x/y.md` -> `?file=x/y.md`
 * against the knowledge panel's own root). Worse, two rows opened a PARENT
 * document rather than the clicked file, because those panels were curated
 * catalogs rather than browsers — a skill's sub-file opened its SKILL.md, and
 * anything under a project opened that project's README, which is why this
 * needed the whole node list just to discover that 8 of 45 skills ship a
 * lowercase `skill.md`. A browser rooted at `$OS_DIR` has one root, no
 * catalogs and no allowlist, so every one of those special cases is gone
 * rather than restated. The ~14 `projects/**` links the brain lane emitted
 * early — deliberately pointing at a destination that 400'd until now — land
 * on the real file.
 *
 * Still takes the node list rather than one path so the call site is
 * unchanged, and so `kind`/`relPath` (not a path guess) stays the thing that
 * decides whether a node is openable at all.
 */
export function fileHrefsFor(nodes: GraphNode[]): Map<string, string> {
  const hrefs = new Map<string, string>();
  for (const node of nodes) {
    // A folder has a real relPath but is not an openable file, and a stub's is
    // null — both fall out here rather than being special-cased per branch.
    if (node.kind !== 'note' || !node.relPath) continue;
    hrefs.set(node.id, withParam(FILES_HREF, 'file', node.relPath));
  }
  return hrefs;
}
