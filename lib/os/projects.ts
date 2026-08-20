import { readdir, readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import matter from 'gray-matter';
import type { Project } from './types/project';
import { expandTilde, osDir } from './paths';

// project-dashboard is this app itself
const SKIP_DIRS = new Set(['project-dashboard']);
const MS_PER_DAY = 86_400_000;
const GIT_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

/**
 * Async and therefore parallelisable. This was `execFileSync` inside the serial
 * loop below, which spawned one BLOCKING git process per project: measured at
 * 2.9 s for 14 projects, during which the SSR event loop served nothing else.
 * Every page pays this — `BaseLayout` calls `getProjects()` for the header
 * count — so it set the floor under every route in the app.
 *
 * Nothing about the result changed; only the scheduling did.
 */
async function gitLastCommit(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'log', '-1', '--format=%cI'],
      { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS },
    );
    const output = stdout.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

export async function getProjects(): Promise<Project[]> {
  const rawDir = process.env.OS_PROJECTS_DIR ?? join(osDir(), 'projects');
  const projectsDir = expandTilde(rawDir);

  const entries = await readdir(projectsDir, { withFileTypes: true });
  const dirNames = entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name);

  // Parallel, but still in `dirNames` order: Promise.all preserves index, so the
  // returned list is byte-for-byte what the old serial loop produced.
  const results = await Promise.all(dirNames.map((dirName) => readProject(projectsDir, dirName)));
  return results.filter((p): p is Project => p !== null);
}

async function readProject(projectsDir: string, dirName: string): Promise<Project | null> {
  {
    const readmePath = join(projectsDir, dirName, 'README.md');
    let content: string;
    try {
      content = await readFile(readmePath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // directory has no README.md — skip silently
      }
      console.warn(`[projects] unexpected error reading ${readmePath}:`, (e as Error).message);
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fm: { [key: string]: any };
    try {
      // The `{}` is load-bearing — see the long comment on parseFrontmatter()
      // in src/lib/osFiles.ts. `matter(raw)` with no options hits gray-matter's
      // module-level cache, which is written BEFORE parsing, so malformed YAML
      // throws once and then every byte-identical call returns the stale
      // never-parsed `data: {}` instead of throwing. Any truthy options object
      // bypasses that branch.
      ({ data: fm } = matter(content, {}));
    } catch (e) {
      console.warn(`[projects] failed to parse frontmatter in ${readmePath}:`, (e as Error).message);
      return null;
    }

    const repoRaw: string | null = (fm.repo as string) ?? null;
    const repoExpanded = repoRaw ? expandTilde(repoRaw) : null;

    const gitDate = repoExpanded ? await gitLastCommit(repoExpanded) : null;
    // gray-matter parses bare YAML dates (2025-05-11) as JS Date objects;
    // convert to ISO string to preserve the date value regardless of local tz.
    const frontmatterDate: string | null = fm.last_active
      ? fm.last_active instanceof Date
        ? fm.last_active.toISOString()
        : String(fm.last_active)
      : null;
    const last_active = gitDate ?? frontmatterDate ?? new Date().toISOString();

    const rawDays = Math.floor((Date.now() - new Date(last_active).getTime()) / MS_PER_DAY);
    const days_since_active = Number.isFinite(rawDays) ? Math.max(0, rawDays) : 0;

    return {
      id: dirName,
      name: fm.name ?? dirName,
      summary: fm.summary ?? null,
      repo: repoRaw,
      github: fm.github ?? null,
      tags: Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === 'string') : [],
      status: fm.status ?? 'unknown',
      priority: fm.priority ?? 'low',
      next_step: fm.next_step ?? null,
      last_active,
      days_since_active,
    };
  }
}
