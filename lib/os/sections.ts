/**
 * The ONE structure that owns nav listing, `?source=` reachability and legacy
 * redirects. A panel that is not in `SECTIONS` is not listed by `Nav`/
 * `SectionTabs`, is not reachable via `?source=`, and has no redirect — the
 * lister and the validator read the same array, so they cannot drift. Adding a
 * panel here is the whole change; nothing else enumerates panels.
 *
 * `heading` is the exact `<h1>` text and `title` the exact `<BaseLayout title>`
 * of the page each panel came from, so a merged section renders identically to
 * its predecessor.
 */

export type Panel = {
  id: string;
  label: string;
  heading: string;
  title: string;
  /** Pre-merge path this panel used to own; redirected here by src/middleware.ts. */
  legacy: string;
};

export type Section = {
  href: string;
  /**
   * The rail caption under the glyph. Uppercase and <= 5 characters — the rail
   * item is 72px wide at `--text-meta`, and a longer word wraps or clips.
   */
  label: string;
  /** Rail glyph shape. Purely decorative rhythm, taken from the design's `nav` array. */
  icon: 'circle' | 'square' | 'rounded';
  /** Header bar, left: the large tracked-out title. Uppercase. */
  title: string;
  /** Header bar, left: the dimmer line beside the title. Uppercase. */
  sub: string;
  /**
   * Footer bar, centre: the static fallback status line. Sections whose real
   * status carries live numbers ("3 ACTIVE · 0 OVERDUE") pass `statusOverride`
   * to BaseLayout instead — a live count is never baked in here, because this
   * array is static and would go stale silently.
   */
  status: string;
  /** First entry is the section's default panel (rendered when `?source=` is absent). */
  panels: Panel[];
};

/**
 * Rail order is the design's `nav` array order: BRAIN, PROJ, CHAT, FILES,
 * INSGT, NOTES. `/` is second, not first — the rail is ordered by how the
 * design reads, not by route depth.
 *
 * Note counts are NOT baked into `sub`. The design shows "201 NODES" in both
 * the Brain subtitle and the header's right-hand stat strip; that is one number
 * in two places, so it lives only in the stat strip, which reads it live.
 */
export const SECTIONS: Section[] = [
  {
    href: '/graph',
    label: 'BRAIN',
    icon: 'circle',
    title: 'KNOWLEDGE',
    sub: 'CORTEX · VOICE READY',
    status: 'VOICE LINK STANDBY · HOLD SPACE TO TALK',
    panels: [
      { id: 'graph', label: 'Graph', heading: 'Graph', title: 'Graph — Project Dashboard', legacy: '/graph' },
    ],
  },
  {
    href: '/',
    label: 'PROJ',
    icon: 'square',
    title: 'PROJECTS',
    sub: 'WHAT AM I WORKING ON, WHERE DOES IT STAND',
    status: 'PROJECT BOARD',
    panels: [
      { id: 'projects', label: 'Board', heading: 'Project Dashboard', title: 'Project Dashboard', legacy: '/' },
    ],
  },
  {
    href: '/chat',
    label: 'CHAT',
    icon: 'rounded',
    title: 'CHAT',
    sub: 'TEXT MODE · MEMORY-AWARE',
    status: 'SANDBOXED AGENT · SCOPED TO $OS_DIR',
    panels: [
      { id: 'chat', label: 'Chat', heading: 'Chat', title: 'Chat — Project Dashboard', legacy: '/chat' },
    ],
  },
  {
    // The five panels below collapse into ONE browse surface (tree + stat tiles
    // + recently-touched table) in the files lane, which owns that page. They
    // stay listed here so `/files` keeps working — and every legacy path keeps
    // redirecting — until that lane lands.
    href: '/files',
    label: 'FILES',
    icon: 'square',
    title: 'FILES',
    sub: 'OS REPO · LOCAL WORKTREE',
    status: 'READ-ONLY OVER $OS_DIR',
    panels: [
      { id: 'knowledge', label: 'Knowledge', heading: 'Knowledge', title: 'Knowledge — Project Dashboard', legacy: '/knowledge' },
      { id: 'memory', label: 'Memory', heading: 'Memory', title: 'Memory — Project Dashboard', legacy: '/memory' },
      { id: 'inbox', label: 'Inbox', heading: 'Inbox', title: 'Inbox — Project Dashboard', legacy: '/inbox' },
      { id: 'skills', label: 'Skills', heading: 'Skills', title: 'Skills — Project Dashboard', legacy: '/skills' },
      { id: 'plans', label: 'Plans', heading: 'Plans', title: 'Plans — Project Dashboard', legacy: '/plans' },
    ],
  },
  {
    // Same deferral as /files: the design renders KPIs, momentum, tokens and
    // recent chats on one grid. The insights lane collapses these three.
    href: '/insights',
    label: 'INSGT',
    icon: 'circle',
    title: 'INSIGHTS',
    sub: 'MOMENTUM · TOKENS · SESSIONS',
    status: 'ROLLING 14-DAY WINDOW',
    panels: [
      { id: 'momentum', label: 'Momentum', heading: 'Momentum', title: 'Momentum — Project Dashboard', legacy: '/momentum' },
      { id: 'recent', label: 'Recent', heading: 'Recent Work', title: 'Recent Work — Project Dashboard', legacy: '/recent' },
      { id: 'tokens', label: 'Tokens', heading: 'Token Usage', title: 'Token Usage — Project Dashboard', legacy: '/tokens' },
    ],
  },
  {
    // Promoted out of `/` — the design gives notes a top-level rail slot.
    href: '/notes',
    label: 'NOTES',
    icon: 'rounded',
    title: 'NOTES',
    sub: 'RAW CAPTURE · AUTO-FILED',
    status: 'JOT NOW, FILE LATER',
    panels: [
      { id: 'notes', label: 'Notes', heading: 'Notes', title: 'Notes — Project Dashboard', legacy: '/notes' },
    ],
  },
];

/**
 * Paths that no longer belong to any panel, so `LEGACY_REDIRECTS` cannot derive
 * them. `/activity` was a section href in v3 and is not one now; a derived map
 * only covers panels, so without this entry the path would 404 rather than
 * redirect. Keep this list empty-by-default: an entry here is a URL the derived
 * map can no longer see, which is exactly the kind of thing that rots.
 */
const RETIRED_PATHS: Record<string, string> = {
  '/activity': '/insights',
};

/** Throws on an unknown href — callers pass a literal from this file, so a miss is a typo, not input. */
export function getSection(href: string): Section {
  const section = SECTIONS.find((s) => s.href === href);
  if (!section) throw new Error(`Unknown section href: ${href}`);
  return section;
}

/**
 * The single reachability guard. `raw` is untrusted query input: it is only ever
 * compared against `panels[].id` of THAT section via `.find` — never used as an
 * object key, so no prototype member (`toString`, `__proto__`) can resolve to a
 * panel. An unknown value returns `null` so the caller can 400 explicitly rather
 * than silently falling through to the default panel.
 */
export function resolveSource(sectionHref: string, raw: string | null): string | null {
  const section = getSection(sectionHref);
  // Every section is defined with at least one panel; `?? null` keeps that
  // invariant from becoming a crash if one is ever defined empty.
  if (raw === null || raw === '') return section.panels[0]?.id ?? null;
  return section.panels.find((p) => p.id === raw)?.id ?? null;
}

/**
 * Derived from SECTIONS, never hand-written: every panel whose pre-merge path is
 * not already its section's path redirects to that section with its `?source=`.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  ...Object.fromEntries(
    SECTIONS.flatMap((section) =>
      section.panels
        .filter((panel) => panel.legacy !== section.href)
        .map((panel) => [panel.legacy, withParam(section.href, 'source', panel.id)] as const),
    ),
  ),
  // Spread last so a retired path always wins: if a future panel reclaims one of
  // these legacy strings, the explicit mapping is the intentional one.
  ...RETIRED_PATHS,
};

/**
 * The ONE place that decides `?` vs `&`. Every href built on top of a section
 * path goes through here — a base now carries `?source=`, so the blind
 * `` `${base}?x=` `` concatenation that used to work produces `?a=1?b=2`.
 */
export function withParam(base: string, key: string, value: string): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${key}=${encodeURIComponent(value)}`;
}

/** The section's own path for its default panel; `?source=<id>` for the rest. */
export function panelHref(section: Section, panel: Panel): string {
  return panel.id === section.panels[0]?.id
    ? section.href
    : withParam(section.href, 'source', panel.id);
}

/** `panelHref` by id — for panels/components that know their own coordinates. */
export function hrefFor(sectionHref: string, panelId: string): string {
  const section = getSection(sectionHref);
  const panel = section.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error(`Unknown panel ${panelId} in section ${sectionHref}`);
  return panelHref(section, panel);
}
