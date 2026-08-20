import { existsSync, readdirSync, realpathSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import matter from 'gray-matter';
import { defineHastPlugin, defineMdastPlugin, markdownToHtml } from 'satteri';
import type { MdastContent } from 'satteri';
import { withParam } from './sections';

// --- Tree -------------------------------------------------------------

export interface TreeFile {
  type: 'file';
  name: string;
  /** Path relative to the tree root, forward-slash separated (e.g. "me/background.md"). */
  relPath: string;
}

export interface TreeDir {
  type: 'dir';
  name: string;
  relPath: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeDir;

/**
 * The ONE hidden-entry rule for this module, used by BOTH `buildTree` (which
 * skips such entries) and `resolveNotePath` (which rejects them). Keeping it
 * as a single predicate is the point: when the walker skipped dot-entries and
 * the guard did not, `/graph` — the first page rooted at `$OS_DIR` itself —
 * served ~1000 hidden `.md` files that appear in no listing
 * (`?file=.claude/worktrees/x/README.md` → HTTP 200 with the body rendered).
 * That is the fourth lister-vs-guard drift this module has shipped; there is
 * now nothing to drift.
 *
 * Deliberately `startsWith('.')` on one path SEGMENT, never `includes('.')` on
 * a whole path — `my.notes.md` is an ordinary, reachable note.
 *
 * `node_modules` is the one non-dot name in here, and it earns its place: the
 * `/files` tree now walks every file rather than only `.md`, so a single stray
 * `npm install` anywhere under `$OS_DIR` would bury the real tree under tens of
 * thousands of rows. Adding it HERE rather than in the walker is the whole
 * point of this predicate — the walker and `resolveNotePath` share it, so a
 * name that stops being listed also stops being fetchable in the same edit,
 * which is the drift this function was extracted to end.
 */
const HIDDEN_NAMES = new Set(['node_modules']);

export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || HIDDEN_NAMES.has(name);
}

/**
 * The path segments of `abs` BELOW `rootAbs`. Only what is below the root is
 * ever inspected: a root's own absolute path may legitimately sit inside a
 * dot-directory (`/plans` roots at project repos, and this repo's own
 * worktrees live under `.claude/worktrees/`). Applying a segment rule to the
 * root's absolute path instead would make those roots unreadable.
 */
function segmentsBelow(rootAbs: string, abs: string): string[] {
  return relative(rootAbs, abs).split(sep);
}

/**
 * Recursively walks `root`, returning files and the directories that contain
 * them. `excludeDirs` matches directory names anywhere in the tree (e.g.
 * "library", "raw"). A nested subdirectory that can't be read (permissions,
 * race with deletion, etc.) is skipped with a warning rather than failing the
 * whole walk — but a `root` that can't be read THROWS, because swallowing that
 * turns a misconfigured `$OS_DIR` into a successful *empty* listing with no
 * error banner. Every caller wraps this in try/catch with a safe fallback +
 * loadError.
 *
 * `extensions` is the file filter, lowercase and dot-prefixed. It defaults to
 * `['.md']` — the shape every pre-existing caller (memory, inbox, skills,
 * plans, the graph) was written against — and `null` means "every file", which
 * is what `/files` passes: that page mirrors the real `$OS_DIR` tree, and
 * `~/os/scripts` holds no markdown at all, so a `.md` filter would delete a
 * whole real top-level folder from the listing. `null` ALSO keeps empty
 * directories, since a folder that exists on disk is a folder the mirror has
 * to show; under an extension filter an empty branch is still dropped, because
 * there a childless directory means "nothing here matched".
 *
 * Matching is case-insensitive so this agrees with `hasExcludedSegment` in
 * `resolveNotePath` — otherwise a dir named `Library` would be listed in the
 * tree but 400 on click. Hidden entries go through the shared `isHiddenName`.
 */
export async function buildTree(
  root: string,
  excludeDirs: string[] = [],
  extensions: string[] | null = ['.md']
): Promise<TreeNode[]> {
  const exclude = new Set(excludeDirs.map((d) => d.toLowerCase()));
  const allowExt = extensions === null ? null : new Set(extensions.map((e) => e.toLowerCase()));

  async function walk(dirAbs: string, relPath: string): Promise<TreeNode[]> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      if (relPath === '') throw err; // the root itself — the whole tree is unreadable
      console.warn('[osFiles] buildTree readdir failed:', dirAbs, err);
      return [];
    }

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (isHiddenName(entry.name)) continue;
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (exclude.has(entry.name.toLowerCase())) continue;
        const children = await walk(join(dirAbs, entry.name), entryRel);
        if (children.length > 0 || allowExt === null) {
          nodes.push({ type: 'dir', name: entry.name, relPath: entryRel, children });
        }
      } else if (entry.isFile() && (allowExt === null || allowExt.has(extname(entry.name).toLowerCase()))) {
        nodes.push({ type: 'file', name: entry.name, relPath: entryRel });
      }
    }

    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
    );
    return nodes;
  }

  return walk(root, '');
}

/** Flattens a tree into its file leaves, depth-first. */
export function listFiles(nodes: TreeNode[]): TreeFile[] {
  const out: TreeFile[] = [];
  for (const node of nodes) {
    if (node.type === 'file') out.push(node);
    else out.push(...listFiles(node.children));
  }
  return out;
}

/**
 * Maps wikilink targets to the file that satisfies them: both the full
 * relative path without extension ("me/background") and the bare basename
 * ("background") resolve to the same file. On a basename collision across
 * folders, the first file encountered (tree order) wins.
 * # ponytail: no case-insensitive matching, no ambiguity warning on collision — add if real notes hit it.
 */
export function collectSlugs(nodes: TreeNode[]): Map<string, string> {
  const slugs = new Map<string, string>();
  for (const file of listFiles(nodes)) {
    const noExt = file.relPath.replace(/\.md$/i, '');
    const base = basename(noExt);
    if (!slugs.has(noExt)) slugs.set(noExt, file.relPath);
    if (!slugs.has(base)) slugs.set(base, file.relPath);
  }
  return slugs;
}

// --- File classification --------------------------------------------------

/** Extensions /inbox treats as a viewable image. Deliberately excludes .svg (see api/inbox-file.ts). */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

export type RawFileKind = 'markdown' | 'image' | 'other';

/**
 * The single predicate for "what kind of file is this", shared by BOTH the
 * /inbox lister (which decides what gets a link) and resolveNotePath's
 * allowedExtensions (which decides what's reachable via that link). This is
 * exactly the kind of rule that drifted before in this module (buildTree's
 * exclusion list vs. resolveNotePath's) once two independent copies existed
 * — so there is only one copy.
 */
export function classifyRawFile(name: string): RawFileKind {
  const ext = extname(name).toLowerCase();
  if (ext === '.md') return 'markdown';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return 'other';
}

// --- Path security ------------------------------------------------------

export interface ResolvedNotePath {
  ok: true;
  absPath: string;
}

export interface RejectedNotePath {
  ok: false;
  /** 400 = escaped/invalid request, 404 = in-bounds but the file doesn't exist. */
  status: 400 | 404;
  reason: string;
}

function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

/**
 * True if any segment of `abs` (relative to `rootAbs`) is an excluded directory
 * name. Exact, case-insensitive match — this filesystem is case-insensitive, and
 * a substring match would wrongly reject real notes whose *name* contains the
 * word (e.g. "memory/feedback-library-notes-format.md" vs excluded "library").
 */
function hasExcludedSegment(rootAbs: string, abs: string, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false;
  return segmentsBelow(rootAbs, abs).some((segment) => excluded.has(segment.toLowerCase()));
}

/** True if any segment below `rootAbs` is a hidden (dot-prefixed) entry — the
 * exact set `buildTree` skips, via the exact same predicate. */
function hasHiddenSegment(rootAbs: string, abs: string): boolean {
  return segmentsBelow(rootAbs, abs).some(isHiddenName);
}

/**
 * True if every segment below `rootAbs` matches its real on-disk name EXACTLY,
 * including case.
 *
 * This filesystem is case-INSENSITIVE, so `existsSync` happily answers yes for
 * `skills/dev-team/SKILL.md` when the file on disk is `skill.md` — 8 of 45
 * skills ship the lowercase spelling. Without this check one file is reachable
 * under many URLs while the tree lists exactly one of them, which is the same
 * lister-vs-guard asymmetry this module has shipped four times, just in the
 * benign direction: the aliases serve the right bytes, so nothing leaks, but
 * "what the page lists" and "what the guard accepts" stop being one set.
 *
 * It matters more now than it did. When `/files` was five curated panels, the
 * catalogs keyed an allowlist on the ACTUAL on-disk name and case-exactness
 * came free. A browser resolves paths instead, so the guard has to say it.
 *
 * Deliberately checks the REQUESTED path (`abs`), not the realpath: symlinks
 * are resolved separately and legitimately change a path, and comparing
 * against a canonicalized name would reject an internal symlink that the
 * containment check already approved. `readdirSync` per level, only on a
 * `?file=` request, at a depth of about four — the rest of this function is
 * already sync.
 */
function hasExactCase(rootAbs: string, abs: string): boolean {
  let dir = rootAbs;
  for (const segment of segmentsBelow(rootAbs, abs)) {
    try {
      if (!readdirSync(dir).includes(segment)) return false;
    } catch {
      return false;
    }
    dir = join(dir, segment);
  }
  return true;
}

/**
 * The single security boundary for turning a `?file=` query param into a
 * filesystem path. Used by both /knowledge and /memory — one guard, not one
 * per page. Never throws.
 *
 * Order: reject cheap-to-check invalid input (null bytes, absolute paths,
 * non-.md extension) before touching the filesystem; resolve and prefix-check
 * (catches `../` traversal); reject excluded directories AND hidden
 * (dot-prefixed) segments — anything `buildTree` refuses to list must not be
 * reachable via `?file=` either; only then check existence
 * (missing-but-in-bounds is a 404, not a 400); finally re-check all three
 * after `realpathSync`-ing BOTH the resolved path and the root, so a symlink
 * can't point outside root — or into an excluded or hidden directory — even
 * though the pre-symlink path looked fine.
 *
 * Both segment rules apply to the path BELOW the root, never to the root's own
 * absolute path (see `segmentsBelow`).
 *
 * `excludeDirs` must match the list passed to `buildTree` for the same root.
 * `allowedExtensions` generalizes the hardcoded `.md`-only check (default
 * `['.md']`, so /knowledge and /memory keep byte-identical behavior) so
 * /inbox's image endpoint can reuse this same guard instead of writing a
 * second one — one path-traversal guard for the whole app, never two.
 */
export function resolveNotePath(
  root: string,
  relPath: string,
  excludeDirs: string[] = [],
  allowedExtensions: string[] = ['.md']
): ResolvedNotePath | RejectedNotePath {
  // Normalize the root once: a caller-supplied trailing separator would
  // otherwise make `isInside`'s `root + sep` compare against `//` and reject
  // every in-bounds path.
  const rootAbs = resolve(root);
  const excluded = new Set(excludeDirs.map((dir) => dir.toLowerCase()));
  const allowedExt = new Set(allowedExtensions.map((ext) => ext.toLowerCase()));

  if (!relPath || relPath.includes('\0')) {
    return { ok: false, status: 400, reason: 'Invalid file path.' };
  }
  if (isAbsolute(relPath)) {
    return { ok: false, status: 400, reason: 'Absolute paths are not allowed.' };
  }
  if (!allowedExt.has(extname(relPath).toLowerCase())) {
    return { ok: false, status: 400, reason: `Only ${allowedExtensions.join(', ')} files can be viewed.` };
  }

  const abs = resolve(rootAbs, relPath);
  if (!isInside(rootAbs, abs)) {
    return { ok: false, status: 400, reason: 'Path escapes the allowed directory.' };
  }
  if (hasExcludedSegment(rootAbs, abs, excluded)) {
    return { ok: false, status: 400, reason: 'This directory is not viewable.' };
  }
  if (hasHiddenSegment(rootAbs, abs)) {
    return { ok: false, status: 400, reason: 'Hidden files are not viewable.' };
  }

  if (!existsSync(abs)) {
    return { ok: false, status: 404, reason: 'Note not found.' };
  }
  // 404, not 400: the path is well-formed and in-bounds, the file as SPELLED
  // just is not there. Runs after existsSync so the common case pays one
  // readdir chain rather than every rejected request paying it.
  if (!hasExactCase(rootAbs, abs)) {
    return { ok: false, status: 404, reason: 'Note not found.' };
  }

  try {
    const realAbs = realpathSync(abs);
    const realRoot = realpathSync(rootAbs);
    if (!isInside(realRoot, realAbs)) {
      return { ok: false, status: 400, reason: 'Path escapes the allowed directory.' };
    }
    if (hasExcludedSegment(realRoot, realAbs, excluded)) {
      return { ok: false, status: 400, reason: 'This directory is not viewable.' };
    }
    if (hasHiddenSegment(realRoot, realAbs)) {
      return { ok: false, status: 400, reason: 'Hidden files are not viewable.' };
    }
  } catch (err) {
    console.warn('[osFiles] resolveNotePath realpath check failed:', relPath, err);
    return { ok: false, status: 404, reason: 'Note not found.' };
  }

  return { ok: true, absPath: abs };
}

// --- Frontmatter + markdown rendering -----------------------------------

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  /** Human-readable message when frontmatter YAML failed to parse; frontmatter is then `{}` and body is the raw file. */
  frontmatterError: string | null;
  body: string;
}

/** gray-matter parses bare YAML dates as JS `Date`s — coerce to ISO strings so pages can render them as text. */
function coerceDates(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/**
 * Renders one frontmatter value as plain text. A self-referencing YAML anchor
 * (`a: &x` / `b: *x`) survives gray-matter but makes `JSON.stringify` throw, and
 * this runs in a template downstream of every try/catch — one bad note must
 * degrade to a placeholder, not 500 the whole page.
 */
export function formatFrontmatterValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '[unserializable]';
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}

/**
 * The parse-failure message for a LIST context — a warning row on /skills or
 * /plans, where the file is deliberately absent from the tree and the
 * allowlist ("not linked means not fetchable"), so nothing is rendered below
 * it. Both listers used to reuse `ParsedFrontmatter.frontmatterError`, whose
 * "— showing the raw file below" tail is only true inside MarkdownViewer;
 * on /skills it promised a raw file that the allowlist then 400s. One string
 * cannot serve both contexts, so the list context gets its own — shared by
 * both listers rather than written twice.
 */
export const FRONTMATTER_LIST_WARNING = 'Frontmatter could not be parsed.';

/**
 * Exported (not just used internally by readFrontmatter/readNote) so
 * `src/lib/graph.ts` can reuse the exact same YAML-cache-bug-avoiding
 * `matter(raw, {})` call and never-throw fallback, instead of a second
 * inline try/catch around a second `matter()` call site.
 */
export function parseFrontmatter(raw: string, absPath: string): ParsedFrontmatter {
  try {
    // The `{}` is load-bearing, not decoration. gray-matter's own source
    // (node_modules/gray-matter/index.js:35-47) gates its module-level
    // `matter.cache[file.content]` on `if (!options)`, and assigns the cache
    // entry BEFORE `parseMatter()` runs. So `matter(raw)` on malformed YAML
    // caches a never-parsed object, then throws — and every later call with
    // byte-identical content is a cache HIT that returns that stale object and
    // never throws again, silently degrading a parse failure to `data: {}`
    // with the raw `---` fence still in `content`. Passing any truthy options
    // object bypasses the cache branch entirely, so the error is reported on
    // every call. Not `matter.clearCache()` — that mutates global state shared
    // with every other gray-matter consumer in the process.
    const parsed = matter(raw, {});
    return { frontmatter: coerceDates(parsed.data ?? {}), frontmatterError: null, body: parsed.content };
  } catch (err) {
    console.warn('[osFiles] parseFrontmatter failed:', absPath, err);
    return {
      frontmatter: {},
      frontmatterError: 'Frontmatter could not be parsed — showing the raw file below.',
      body: raw,
    };
  }
}

/** Lightweight metadata-only read (frontmatter, no markdown render) — for listing pages like /memory. */
export async function readFrontmatter(absPath: string): Promise<Pick<ParsedFrontmatter, 'frontmatter' | 'frontmatterError'>> {
  try {
    const raw = await readFile(absPath, 'utf-8');
    const { frontmatter, frontmatterError } = parseFrontmatter(raw, absPath);
    return { frontmatter, frontmatterError };
  } catch (err) {
    console.warn('[osFiles] readFrontmatter failed:', absPath, err);
    return { frontmatter: {}, frontmatterError: null };
  }
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * The trim + `.md`-strip that turns a raw `[[target]]` capture into the slug
 * key used to look up `collectSlugs()`'s map. Shared by the viewer's
 * `wikilinkPlugin` (below) and the graph builder's `collectLinkTargets`
 * consumer (`src/lib/graph.ts`) so both features tokenize a wikilink target
 * identically — one definition, not two copies that can drift.
 */
export function normalizeWikilinkTarget(target: string): string {
  return target.trim().replace(/\.md$/i, '');
}

/**
 * Text-node-only visitor (never a regex over the raw markdown string) so a
 * `[[looks like a wikilink]]` inside a code fence — a different mdast node
 * type — is never touched. Known targets become real links; unknown targets
 * are left as literal `[[text]]` — never a dead link.
 */
function wikilinkPlugin(slugMap: Map<string, string>, hrefBase: string) {
  return defineMdastPlugin({
    name: 'os-wikilinks',
    text(node, ctx) {
      if (!node.value.includes('[[')) return;
      const parts: MdastContent[] = [];
      let last = 0;
      let matched = false;

      for (const match of node.value.matchAll(WIKILINK_RE)) {
        matched = true;
        const [full, target, alias] = match;
        const index = match.index ?? 0;
        if (index > last) parts.push({ type: 'text', value: node.value.slice(last, index) });

        // The regex cannot match without group 1, but the compiler cannot know
        // that; skip rather than assert, so a future regex edit degrades safely.
        if (target === undefined) continue;
        const slug = normalizeWikilinkTarget(target);
        const label = (alias ?? target).trim();
        const relPath = slugMap.get(slug);
        if (relPath) {
          parts.push({
            type: 'link',
            url: withParam(hrefBase, 'file', relPath),
            children: [{ type: 'text', value: label }],
          });
        } else {
          parts.push({ type: 'text', value: full });
        }
        last = index + full.length;
      }

      if (!matched) return;
      if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
      ctx.insertBefore(node, parts);
      ctx.removeNode(node);
    },
  });
}

export interface CollectedLink {
  kind: 'wikilink' | 'markdown';
  /**
   * `wikilink` — the raw `[[target]]` capture, pre-normalization (call
   * `normalizeWikilinkTarget`). `markdown` — an already-filtered `.md` path,
   * still relative to the linking file; resolving it against that file's
   * directory is the caller's job (`src/lib/graph.ts` is the side that holds
   * the relPath).
   */
  target: string;
}

// Any scheme (`https:`, `mailto:`, `javascript:`, `data:`) or a
// protocol-relative `//host` points outside the note tree.
const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

// No real note filename holds a C0 control or DEL, and one must never reach a
// node id or the SSR JSON payload (`x%00.md`, `x%0a.md` did). This also covers
// the tab/LF/CR that real URL parsers strip before parsing — `javascript\t:`
// IS a scheme, and is blocked here rather than by a second strip-then-rescan
// rule, which a 23,350-input sweep showed could never change an outcome.
const CONTROL_RE = /[\x00-\x1f\x7f]/;

// `%2568ttps%3A` needs two decode rounds to become `https:`, plus one to prove
// it settled. Anything still changing after this many is smuggling, not a name.
const MAX_DECODE_ROUNDS = 4;

/**
 * Percent-decodes until the value stops changing, so ONE decode level can't be
 * used to hide a scheme (`%2568ttps%3A` decodes once to `%68ttps:` — a
 * `%`-leading string no scheme regex matches). Null when it is still changing
 * at the cap. A malformed `%` sequence throws: keep the last good value, so a
 * file genuinely named `100%.md` keeps its link.
 *
 * Accepted trade, in both directions and neither reachable in `~/os` today
 * (zero `%XX` filenames): decoding past one level means a real file named
 * `my%20note.md` linked as `my%2520note.md` over-decodes to a `my note` stub
 * instead of resolving; and the last-good-value return means appending a
 * malformed `%` to an encoded scheme (`%68ttps%3A//e.com/x%.md`) skips the
 * decoded-side check. The residue is inert — it can only mint a stub, and a
 * stub is rendered as escaped text, never as an href (see graph.astro). Decode
 * per-escape instead ONLY if that stops being true; it byte-decodes UTF-8, so
 * `caf%C3%A9.md` would break, which is the likelier filename of the two.
 */
function decodeToFixpoint(value: string): string | null {
  let current = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

/** The rule itself: not a pure `#anchor`, not a scheme or `//host`, no control characters. */
function isInTree(value: string): boolean {
  if (!value || value.startsWith('#')) return false; // pure anchor — same document
  if (URL_SCHEME_RE.test(value)) return false;
  return !CONTROL_RE.test(value);
}

/**
 * Drops anything that isn't an in-tree path — a scheme, a protocol-relative
 * `//host`, a pure `#anchor`, a control character — then cuts
 * `#fragment`/`?query`. The ONE place that rule lives.
 *
 * The checks run on the raw url AND again on the fully decoded value, because
 * decoding can re-introduce exactly what they drop (`htt%70s://x/y.md`,
 * `javascript%3Ax.md`, `x%23f.md`). BOTH passes are load-bearing — do not
 * delete either as redundant: the decoded pass catches what decoding reveals,
 * and the raw pass is the sole blocker when decoding *removes* the evidence
 * (`x.md\t%09` decodes to `x.md\t\t`, which trims to a clean `x.md`).
 * Accepted cost: a file literally named `TODO: x.md` looks like a scheme and
 * loses its edge.
 */
function inTreePath(value: string): string | null {
  const raw = value.trim();
  if (!isInTree(raw)) return null;
  const settled = decodeToFixpoint(raw);
  if (settled === null) return null;
  const decoded = settled.trim();
  if (!isInTree(decoded)) return null;
  const [path] = decoded.split(/[#?]/, 1);
  return path || null;
}

/**
 * The one filter deciding whether a markdown link url is an in-tree note
 * reference: `inTreePath` above, then `.md`-only. Returns null for everything
 * else (external schemes, pure anchors, non-`.md` files) so exactly one place
 * decides what becomes a graph edge — and the same value becomes the node.
 */
function markdownLinkTarget(url: string): string | null {
  const target = inTreePath(url);
  if (target === null) return null;
  // `[^/\\]` demands a non-empty basename: a bare `/\.md$/i` accepts `dir/.md`,
  // which mints a `stub:dir/` node labelled with a trailing slash.
  return /[^/\\]\.md$/i.test(target) ? target : null;
}

/**
 * Collects every outbound link in `body` — `[[wikilinks]]` and markdown
 * `[text](file.md)` links alike — in ONE mdast pass, via the SAME visitor path
 * `wikilinkPlugin` above uses, so a link-shaped string inside a code fence (a
 * different mdast node type) is excluded exactly like it is for the viewer. A
 * raw-regex pass over the markdown source instead finds phantom links the
 * viewer never renders — verified twice over the live ~/os tree: 63 regex
 * matches vs. 57 real wikilinks, and 48 vs. 47 real markdown links. This is
 * the only zero-drift option, and one parse (~46ms) covers both link kinds.
 *
 * `![alt](x.png)` is excluded structurally, not by filtering: satteri
 * dispatches image nodes to a separate `image` hook that this plugin never
 * declares, so an embed cannot reach the `link` visitor. `[![alt](i.png)](t.md)`
 * therefore yields exactly one link (the outer `t.md`) — verified empirically.
 * Reference links (`[a][ref]`) are `linkReference` nodes and are likewise not
 * collected; ~/os uses none today.
 * # ponytail: renders the whole document just to throw the html away —
 * upgrade to a parse-only satteri API if one ever ships.
 * Never throws — a malformed document degrades to zero links, not a crash.
 */
export function collectLinkTargets(body: string): CollectedLink[] {
  const targets: CollectedLink[] = [];
  try {
    markdownToHtml(body, {
      mdastPlugins: [
        defineMdastPlugin({
          name: 'os-link-collector',
          text(node) {
            if (!node.value.includes('[[')) return;
            for (const match of node.value.matchAll(WIKILINK_RE)) {
              const target = match[1];
              if (target !== undefined) targets.push({ kind: 'wikilink', target });
            }
          },
          link(node) {
            const target = markdownLinkTarget(node.url);
            if (target) targets.push({ kind: 'markdown', target });
          },
        }),
      ],
    });
  } catch (err) {
    console.warn('[osFiles] collectLinkTargets failed:', err);
    return [];
  }
  return targets;
}

// satteri passes inline HTML straight through as opaque `raw` hast nodes
// (verified: <script>, onerror=, javascript:-href all serialize unescaped).
// There's no rehype-raw equivalent to parse them into elements a sanitizer
// could inspect, so the simplest correct fix is: notes don't get to embed
// live HTML at all — render it as literal escaped text instead. Built once,
// reused across every render (stateless).
const stripRawHtmlPlugin = defineHastPlugin({
  name: 'os-strip-raw-html',
  raw(node) {
    return { type: 'text', value: node.value };
  },
});

// `\/(?!\/)` — a single leading slash is a same-origin path, but `//evil.com`
// is a protocol-relative URL that would leave the site.
const ALLOWED_HREF = /^(https?:|mailto:|#|\/(?!\/)|\.)/i;
const ALLOWED_SRC = /^(https?:|data:image\/|\/(?!\/)|\.)/i;

// Real markdown link/image syntax (not raw HTML) still reaches normal hast
// `element` nodes, so `javascript:`/`data:`-scheme hrefs need their own
// check — the same http(s)-only allowlist this repo already uses for
// project.github links (see ProjectCard.astro's `safeGithub`).
const safeLinksPlugin = defineHastPlugin({
  name: 'os-safe-links',
  element: [
    {
      filter: ['a'],
      visit(node, ctx) {
        const href = node.properties?.href;
        if (typeof href === 'string' && !ALLOWED_HREF.test(href)) {
          ctx.setProperty(node, 'href', undefined);
        }
      },
    },
    {
      filter: ['img'],
      visit(node, ctx) {
        const src = node.properties?.src;
        if (typeof src === 'string' && !ALLOWED_SRC.test(src)) {
          ctx.setProperty(node, 'src', undefined);
        }
      },
    },
  ],
});

function renderMarkdown(body: string, slugMap: Map<string, string>, hrefBase: string): string {
  const { html } = markdownToHtml(body, {
    mdastPlugins: [wikilinkPlugin(slugMap, hrefBase)],
    hastPlugins: [stripRawHtmlPlugin, safeLinksPlugin],
  }) as { html: string };
  return html;
}

export interface NoteResult {
  frontmatter: Record<string, unknown>;
  frontmatterError: string | null;
  html: string;
}

/** Full read: frontmatter + sanitized, wikilink-resolved HTML for the detail view. Never throws. */
export async function readNote(
  absPath: string,
  opts: { slugMap: Map<string, string>; hrefBase: string }
): Promise<NoteResult> {
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf-8');
  } catch (err) {
    console.warn('[osFiles] readNote read failed:', absPath, err);
    return { frontmatter: {}, frontmatterError: null, html: '<p><em>Could not read this file.</em></p>' };
  }

  const { frontmatter, frontmatterError, body } = parseFrontmatter(raw, absPath);

  let html: string;
  try {
    html = renderMarkdown(body, opts.slugMap, opts.hrefBase);
  } catch (err) {
    console.warn('[osFiles] readNote render failed:', absPath, err);
    html = '<p><em>Could not render this note.</em></p>';
  }

  return { frontmatter, frontmatterError, html };
}
