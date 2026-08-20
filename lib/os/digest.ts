import type { MergedProject } from './types/project';

export interface DigestBuckets {
  moved: MergedProject[];
  overdue: MergedProject[];
  comingUp: MergedProject[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Compute the three weekly-digest buckets from a list of merged projects.
 *
 * @param projects - full project list from getMergedProjects()
 * @param today - ISO-8601 date string (YYYY-MM-DD), defaults to current date
 * @param sevenDaysFromNow - ISO-8601 date string (YYYY-MM-DD), defaults to today + 7
 */
export function computeDigestBuckets(
  projects: MergedProject[],
  today?: string,
  sevenDaysFromNow?: string,
): DigestBuckets {
  // Derive both bounds from a single clock read to avoid split-clock hazard.
  const now = new Date();
  const resolvedToday = today ?? now.toISOString().slice(0, 10);
  const resolvedSevenDaysFromNow = sevenDaysFromNow ?? (() => {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const moved: MergedProject[] = [];
  const overdue: MergedProject[] = [];
  const comingUp: MergedProject[] = [];

  for (const project of projects) {
    if (project.days_since_active <= 7) {
      moved.push(project);
    }
    // Validate due_date format before any string comparison; skip if malformed.
    const due = project.due_date && DATE_RE.test(project.due_date) ? project.due_date : null;
    if (project.overdue) {
      overdue.push(project);
    } else if (due && due >= resolvedToday && due <= resolvedSevenDaysFromNow) {
      comingUp.push(project);
    }
  }

  return { moved, overdue, comingUp };
}
