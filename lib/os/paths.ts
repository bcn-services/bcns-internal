import { homedir } from 'os';
import { isAbsolute, join } from 'path';

/**
 * Expands a leading `~` or `~/` to the current user's home directory.
 * Only the bare home-dir form is supported: `~` and `~/…`.
 * `~username/foo` paths are passed through unchanged (git will reject them).
 */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Returns the expanded OS_DIR root: the OS_DIR env var if set (and
 * non-blank), otherwise `~/os`. Read at call time (never module load) so
 * tests can override via vi.stubEnv. Trailing slashes are stripped so the
 * result is a usable dir root (`/` itself is preserved). If the expanded
 * value isn't absolute (e.g. a relative OS_DIR like `os` or `../os`), warns
 * and falls back to the `~/os` default rather than silently resolving
 * against process.cwd() later (which differs between `astro dev` and the
 * standalone prod entry point).
 */
export function osDir(): string {
  const fallback = expandTilde('~/os').replace(/\/+$/, '');
  const raw = process.env.OS_DIR?.trim() || '~/os';
  const expanded = expandTilde(raw);
  if (!isAbsolute(expanded)) {
    console.warn('[paths] OS_DIR is not an absolute path, ignoring:', raw);
    return fallback;
  }
  const dir = expanded.replace(/\/+$/, '');
  return dir || '/';
}
