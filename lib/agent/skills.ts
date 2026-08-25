/**
 * skills.ts — which skills exist, who may RUN one, and who is SHOWN one.
 *
 * Two questions, deliberately two functions, because they answer to different
 * authorities and only one of them is a security boundary:
 *
 *   `mayRunSkill(role, name)`  — the gate. Role only (`admin` | `member`, from
 *                                the JWT's app_metadata). This is what the API
 *                                route calls, and it never sees job_function.
 *   `skillButtonsFor(...)`     — the convenience. Role AND job_function, to
 *                                keep a developer's page free of buttons that
 *                                would only ever run the wrong thing.
 *
 * A forged POST therefore reaches `mayRunSkill` and is refused there; hiding a
 * button never was the control. Keeping job_function out of the gate is also
 * why it stays out of RLS and out of the JWT — nothing security-critical reads
 * it, so nothing security-critical has to trust it.
 *
 * NULL job_function means SKIP, not GUESS — the same reading 0009 states for
 * the briefing job. A member whose function nobody has set gets no skill
 * buttons and a page that still works; an admin gets their buttons anyway,
 * because role is the axis that grants them and job_function is not a demotion.
 *
 * `ops` is not a mistake either: the item grants pitch/quote/intake to sales
 * and admin, so ops sees none. Add ops to a skill's `jobFunctions` the day an
 * ops skill exists.
 *
 * NO DEVELOPER SKILL IS HERE. dev-team, the dt-* agents, lane, map, ship,
 * branch, merge-lane, foundation and new-client-repo all need a cloned repo, a
 * worktree and a real shell. The runner gives an agent no Bash (see
 * runner.ts), so a button for one would not fail informatively — it would run,
 * flail, and bill for it. They stay laptop-side.
 *
 * Pure module: no I/O, no env, no `server-only`. It is imported by a server
 * page, by a route handler and by the tests alike.
 */

import type { CallerRole } from "./verbs/types";

/** The three values 0009 allows in `profiles.job_function`. Null is a fourth state. */
export const JOB_FUNCTIONS = ["developer", "sales", "ops"] as const;
export type JobFunction = (typeof JOB_FUNCTIONS)[number];

/** Narrow whatever the database handed back to a JobFunction, or null. */
export function asJobFunction(raw: unknown): JobFunction | null {
  return (JOB_FUNCTIONS as readonly unknown[]).includes(raw) ? (raw as JobFunction) : null;
}

/**
 * Where a button can appear. `lead` and `client` are per-record surfaces (one
 * button set per account/client on the page); `leads` and `admin` are the
 * page itself.
 */
export type SkillSurface = "lead" | "client" | "leads" | "admin";

export interface SkillDef {
  /** Button text. */
  label: string;
  /**
   * Roles that may RUN it. Same vocabulary and same shape as a verb's `roles`
   * in lib/agent/verbs/index.ts, so "who may do this" is spelled one way in
   * this codebase rather than two.
   */
  roles: readonly CallerRole[];
  /** Job functions that are SHOWN it. Admin sees it regardless; see above. */
  jobFunctions: readonly JobFunction[];
  /** Pages it belongs on. */
  surfaces: readonly SkillSurface[];
}

/**
 * The registry. Keys are the skill names as bcns-os defines them; the runner
 * loads them namespaced (`bcns-os:pitch`) via `--plugin-dir .`.
 */
export const SKILLS: Readonly<Record<string, SkillDef>> = Object.freeze({
  pitch: {
    label: "Draft a pitch",
    roles: ["admin", "member"],
    jobFunctions: ["sales"],
    surfaces: ["lead", "client"],
  },
  quote: {
    label: "Draft a quote",
    roles: ["admin", "member"],
    jobFunctions: ["sales"],
    surfaces: ["lead", "client"],
  },
  intake: {
    label: "Run intake",
    roles: ["admin", "member"],
    jobFunctions: ["sales"],
    surfaces: ["client"],
  },
  leads: {
    label: "Find leads",
    roles: ["admin"],
    jobFunctions: [],
    surfaces: ["leads"],
  },
  "improve-system": {
    label: "Improve the system",
    roles: ["admin"],
    jobFunctions: [],
    surfaces: ["admin"],
  },
});

export const SKILL_NAMES: readonly string[] = Object.keys(SKILLS);

/**
 * THE GATE. Everything the route needs to decide, from the one claim the JWT
 * actually carries. An unknown name is false, not a throw: a POST naming a
 * skill that does not exist is refused the same way as one naming a skill the
 * caller may not have.
 *
 * `Object.hasOwn`, not truthiness — `SKILLS["toString"]` would otherwise reach
 * Object.prototype and hand back a function whose `.roles` is undefined.
 */
export function mayRunSkill(role: CallerRole | null, name: unknown): boolean {
  if (role === null || typeof name !== "string" || !Object.hasOwn(SKILLS, name)) return false;
  return (SKILLS[name] as SkillDef).roles.includes(role);
}

export interface SkillButton {
  name: string;
  label: string;
}

/**
 * The buttons to render on one surface. A skill appears only if the viewer may
 * actually run it, so a hidden gate failure is impossible: the UI is a strict
 * subset of what `mayRunSkill` allows.
 *
 * A `developer` never matches any `jobFunctions` list, so a member developer
 * gets `[]` on every surface — which is the item's first acceptance criterion
 * and is asserted directly against this function.
 */
export function skillButtonsFor(
  surface: SkillSurface,
  role: CallerRole | null,
  jobFunction: JobFunction | null,
): SkillButton[] {
  return Object.entries(SKILLS)
    .filter(([name, def]) => {
      if (!def.surfaces.includes(surface)) return false;
      if (!mayRunSkill(role, name)) return false;
      // Role admin is its own grant; below that, job_function decides.
      return role === "admin" || (jobFunction !== null && def.jobFunctions.includes(jobFunction));
    })
    .map(([name, def]) => ({ name, label: def.label }));
}

/**
 * The prompt one button sends. Built HERE, from a name that survived the
 * registry lookup and a subject the server read out of the database — never
 * from browser text. The runner's agent has Read/Edit/Write/Glob/Grep/Skill in
 * a writable clone of the os, so a free-text subject would be an injection
 * channel straight into it.
 */
export function skillPrompt(name: string, subject: string | null): string {
  const skill = `bcns-os:${name}`;
  return subject
    ? `Use the ${skill} skill for ${subject}.`
    : `Use the ${skill} skill.`;
}
