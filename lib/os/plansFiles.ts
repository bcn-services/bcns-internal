import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { FRONTMATTER_LIST_WARNING, isHiddenName, readFrontmatter, resolveNotePath } from './osFiles';
import type { TreeDir, TreeFile } from './osFiles';
import { expandTilde } from './paths';

export interface PlanWarning {
  project: string;
  reason: string;
}

export interface PlansResult {
  /** One TreeDir per project that has at least one of PLAN.md/PROGRESS.md. */
  tree: TreeDir[];
  /** selector (`<slug>/PLAN.md`) -> absolute path. The only source of truth
   * for what `?file=` may resolve to on /plans — see plans.astro. */
  allowlist: Map<string, string>;
  warnings: PlanWarning[];
}

const PLAN_FILE_NAMES = ['PLAN.md', 'PROGRESS.md'];

/**
 * Reads each $OS_DIR/projects/*\/README.md's `repo:` frontmatter, then looks
 * for PLAN.md/PROGRESS.md inside that repo dir — which lives OUTSIDE
 * $OS_DIR, so this is the one page in the app that deliberately reads
 * beyond the os-dir boundary. Every file it opens is still reached through
 * resolveNotePath(), just rooted at the project's own repo dir instead of
 * $OS_DIR: same existence check, same excluded-segment check, same
 * realpath symlink re-check. The shared guard is reused with a different
 * root, never bypassed and never re-implemented.
 *
 * A root-level readdir failure (of $OS_DIR/projects itself) propagates for
 * a loadError banner. Per-project failures (no repo: field, repo path
 * missing on disk, unparseable README frontmatter) become warnings; a
 * project whose repo exists but simply has neither file is normal and
 * silent — it contributes no tree entry at all.
 */
export async function listProjectPlans(osProjectsRoot: string): Promise<PlansResult> {
  const dirEntries = await readdir(osProjectsRoot, { withFileTypes: true });
  const projectSlugs = dirEntries
    .filter((e) => e.isDirectory() && !isHiddenName(e.name))
    .map((e) => e.name);

  const tree: TreeDir[] = [];
  const allowlist = new Map<string, string>();
  const warnings: PlanWarning[] = [];

  await Promise.all(
    projectSlugs.map(async (slug) => {
      const readmePath = join(osProjectsRoot, slug, 'README.md');
      const { frontmatter, frontmatterError } = await readFrontmatter(readmePath);

      // Same list-vs-viewer context split as skillsFiles.ts: a warned project
      // contributes no tree row and no allowlist entry, so "showing the raw
      // file below" would be a lie here too. Latent today (no project README
      // has broken YAML) — fixed at the same time as its live twin.
      if (frontmatterError) {
        warnings.push({ project: slug, reason: FRONTMATTER_LIST_WARNING });
        return;
      }

      const repo = typeof frontmatter.repo === 'string' ? frontmatter.repo.trim() : '';
      if (!repo) {
        warnings.push({ project: slug, reason: 'No repo: field in README.' });
        return;
      }

      const repoRoot = expandTilde(repo);
      try {
        const info = await stat(repoRoot);
        if (!info.isDirectory()) {
          warnings.push({ project: slug, reason: `repo: path is not a directory (${repo}).` });
          return;
        }
      } catch (err) {
        console.warn('[plansFiles] repo path missing:', repoRoot, err);
        warnings.push({ project: slug, reason: `repo: path does not exist on disk (${repo}).` });
        return;
      }

      const children: TreeFile[] = [];
      for (const fileName of PLAN_FILE_NAMES) {
        const resolved = resolveNotePath(repoRoot, fileName);
        if (resolved.ok) {
          const relPath = `${slug}/${fileName}`;
          children.push({ type: 'file', name: fileName, relPath });
          allowlist.set(relPath, resolved.absPath);
        }
        // !ok here just means this project doesn't track that file — not a warning.
      }

      if (children.length > 0) {
        tree.push({ type: 'dir', name: slug, relPath: slug, children });
      }
    })
  );

  tree.sort((a, b) => a.name.localeCompare(b.name));
  warnings.sort((a, b) => a.project.localeCompare(b.project));

  return { tree, allowlist, warnings };
}
