import { readdir } from 'fs/promises';
import { join } from 'path';
import { FRONTMATTER_LIST_WARNING, isHiddenName, readFrontmatter, resolveNotePath } from './osFiles';
import type { TreeFile } from './osFiles';

export interface SkillWarning {
  folder: string;
  reason: string;
}

export interface SkillsResult {
  /** Flat (not nested) — every successfully-parsed skill is a top-level entry. */
  tree: TreeFile[];
  /** Keyed on relPath, same convention as /memory's descriptions map. */
  descriptions: Map<string, string>;
  /** relPath (`<folder>/<actual on-disk skill filename>`) -> absolute path.
   * The only source of truth for what `?file=` may resolve to on /skills —
   * see skills.astro. Same shape and contract as plansFiles.ts's allowlist.
   *
   * An entry is added at exactly the point a tree row is pushed, from the same
   * readdir Dirent, so "what the page links" and "what the page will serve"
   * are one decision, not two rules that can drift. That drift is what let 32
   * unlisted `.md` files under skills/ be fetched directly via `?file=` while
   * the tree only ever listed one skill.md per folder — and the earlier
   * case-sensitivity split between buildTree and resolveNotePath was the same
   * bug family. A folder that only produces a warning row is deliberately
   * absent here: not linked means not fetchable.
   */
  allowlist: Map<string, string>;
  warnings: SkillWarning[];
}

const SKILL_FILE_RE = /^skill\.md$/i;

/**
 * Scans each subdirectory of `root` (~/os/skills) for a case-insensitively
 * named skill.md — 8 of 36 real folders name it lowercase `skill.md`, and
 * this filesystem's case-insensitivity means a readdir() scan for the exact
 * string 'SKILL.md' would silently drop those 8 (they'd still *open* by
 * accident, but never be *found*). Matching case-insensitively against the
 * directory listing is correct on both case-sensitive and -insensitive
 * filesystems.
 *
 * Every folder is accounted for on return: either a tree entry (frontmatter
 * name + description both present and parsed) or a warning explaining why
 * not. Non-directory entries at the root (INDEX.md, skills.md) and dotfiles
 * are skipped, not warned on — they were never candidate skill folders.
 *
 * A root-level readdir failure propagates (caller shows a loadError
 * banner); a per-folder failure becomes a warning, never a crash or a
 * silently-dropped folder.
 */
export async function listSkills(root: string): Promise<SkillsResult> {
  const dirEntries = await readdir(root, { withFileTypes: true });
  const folders = dirEntries.filter((e) => e.isDirectory() && !isHiddenName(e.name));

  const tree: TreeFile[] = [];
  const descriptions = new Map<string, string>();
  const allowlist = new Map<string, string>();
  const warnings: SkillWarning[] = [];

  await Promise.all(
    folders.map(async (folder) => {
      const folderAbs = join(root, folder.name);

      let files;
      try {
        files = await readdir(folderAbs, { withFileTypes: true });
      } catch (err) {
        console.warn('[skillsFiles] readdir failed:', folderAbs, err);
        warnings.push({ folder: folder.name, reason: 'Could not read this folder.' });
        return;
      }

      const skillFile = files.find((f) => f.isFile() && SKILL_FILE_RE.test(f.name));
      if (!skillFile) {
        warnings.push({ folder: folder.name, reason: 'No skill.md found.' });
        return;
      }

      // relPath is built from the ACTUAL on-disk names readdir just returned,
      // then run through the same shared guard /knowledge, /memory and /plans
      // use — reused with a different root, never bypassed, never
      // re-implemented. It cannot reject a name readdir produced (single path
      // segments, `.md`, exists, and Dirent.isFile()/isDirectory() already
      // excluded symlinks), but a folder must never vanish silently if it
      // somehow does.
      const relPath = `${folder.name}/${skillFile.name}`;
      const resolved = resolveNotePath(root, relPath);
      if (!resolved.ok) {
        console.warn('[skillsFiles] resolveNotePath rejected:', relPath, resolved.reason);
        warnings.push({ folder: folder.name, reason: 'Could not read this skill file.' });
        return;
      }

      const { frontmatter, frontmatterError } = await readFrontmatter(resolved.absPath);

      // NOT `frontmatterError` — that string ends "showing the raw file
      // below", which is false here: this folder gets no tree row and no
      // allowlist entry, so the page shows nothing below and `?file=` 400s.
      if (frontmatterError) {
        warnings.push({ folder: folder.name, reason: FRONTMATTER_LIST_WARNING });
        return;
      }

      const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
      const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';

      if (!name || !description) {
        warnings.push({ folder: folder.name, reason: 'Missing name or description in frontmatter.' });
        return;
      }

      tree.push({ type: 'file', name, relPath });
      descriptions.set(relPath, description);
      allowlist.set(relPath, resolved.absPath);
    })
  );

  tree.sort((a, b) => a.name.localeCompare(b.name));
  warnings.sort((a, b) => a.folder.localeCompare(b.folder));

  return { tree, descriptions, allowlist, warnings };
}
