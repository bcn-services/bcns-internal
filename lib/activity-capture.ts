/**
 * activity-capture.ts — the confirmation step's logic, with no React in it.
 *
 * The rule this file exists to make testable: NOTHING REACHES THE DATABASE
 * UNTIL A PERSON HAS SEEN IT AND SAID YES. So the state machine has exactly
 * two steps, and only one of them can produce a commit payload:
 *
 *     compose  ──parse──▶  confirm  ──commit──▶  compose (cleared)
 *        ▲                    │
 *        └──────cancel────────┘
 *
 * A PARSE FAILURE LANDS IN `confirm` TOO, seeded from the raw text. That is
 * deliberate and it is the guardrail: the words someone typed are never thrown
 * away because a model could not read them — they arrive in the note field with
 * the reason shown, ready to be filed by hand.
 *
 * The date is edited as a plain local `YYYY-MM-DD` (what `<input type="date">`
 * gives) and converted back to an instant in the submitter's own zone, keeping
 * the time of day the parse found. See ./agent/activity-parse.ts.
 */

import { localDate, withLocalDate, type ParsedActivity } from "./agent/activity-parse";
import type { ActivityKind } from "./agent/verbs/activity_query";

/** The row as the confirmation form holds it. Every field is editable. */
export interface ActivityDraft {
  kind: ActivityKind;
  /** ISO instant. Edited through `dateLocal` below. */
  occurredAt: string;
  outcome: string;
  note: string;
}

export interface CaptureState {
  step: "compose" | "confirm";
  /** What the person typed. Kept through `confirm` so Cancel can restore it. */
  text: string;
  draft: ActivityDraft | null;
  /** Shown to the person: a parse failure, or a rejected commit. */
  message: string | null;
  busy: boolean;
}

export type CaptureAction =
  | { type: "type"; text: string }
  | { type: "parsing" }
  | { type: "parsed"; proposal: ParsedActivity }
  | { type: "parse_failed"; message: string; now: Date }
  | { type: "edit"; field: "kind" | "outcome" | "note"; value: string }
  | { type: "edit_date"; value: string; timeZone: string }
  | { type: "committing" }
  | { type: "commit_failed"; message: string }
  | { type: "committed" }
  | { type: "cancel" };

export const emptyCapture = (): CaptureState => ({
  step: "compose",
  text: "",
  draft: null,
  message: null,
  busy: false,
});

/**
 * The draft a person gets when the parser could not read their text. `note` is
 * their own words verbatim — losing them would be the failure mode this whole
 * confirmation step exists to prevent.
 */
export function manualDraft(text: string, now: Date): ActivityDraft {
  return { kind: "note", occurredAt: now.toISOString(), outcome: "", note: text.trim() };
}

export function captureReducer(state: CaptureState, action: CaptureAction): CaptureState {
  switch (action.type) {
    case "type":
      return { ...state, text: action.text, message: null };

    case "parsing":
      return { ...state, busy: true, message: null };

    case "parsed":
      return {
        ...state,
        step: "confirm",
        busy: false,
        message: null,
        draft: {
          kind: action.proposal.kind,
          occurredAt: action.proposal.occurredAt,
          outcome: action.proposal.outcome ?? "",
          note: action.proposal.note,
        },
      };

    case "parse_failed":
      return {
        ...state,
        step: "confirm",
        busy: false,
        message: `${action.message} — check it over and file it by hand.`,
        draft: manualDraft(state.text, action.now),
      };

    case "edit":
      if (!state.draft) return state;
      return { ...state, message: null, draft: { ...state.draft, [action.field]: action.value } };

    case "edit_date": {
      if (!state.draft) return state;
      // An empty or half-typed date input must not corrupt the instant.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(action.value)) return state;
      return {
        ...state,
        message: null,
        draft: {
          ...state.draft,
          occurredAt: withLocalDate(state.draft.occurredAt, action.value, action.timeZone),
        },
      };
    }

    case "committing":
      return { ...state, busy: true, message: null };

    case "commit_failed":
      return { ...state, busy: false, message: action.message };

    // Cleared, not merely stepped back: leaving the text behind after a
    // successful write is how the same call gets logged twice.
    case "committed":
      return emptyCapture();

    case "cancel":
      return { ...state, step: "compose", draft: null, busy: false, message: null };

    default:
      return state;
  }
}

/** What the date input shows for the current draft, in the submitter's zone. */
export function draftDateLocal(draft: ActivityDraft, timeZone: string): string {
  return localDate(new Date(draft.occurredAt), timeZone);
}

/** The shape both the server action and log_activity take. */
export interface CommitPayload {
  accountId?: string;
  clientId?: string;
  kind: ActivityKind;
  note: string;
  outcome: string | null;
  occurredAt: string;
}

/**
 * The payload the Confirm button submits — built from the EDITED draft, never
 * from the parse. Returns null outside the confirm step, which is the code-level
 * form of "nothing commits without a confirmation".
 */
export function commitPayload(
  state: CaptureState,
  target: { accountId?: string; clientId?: string },
): CommitPayload | null {
  if (state.step !== "confirm" || !state.draft) return null;
  const { kind, occurredAt, outcome, note } = state.draft;
  return {
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.clientId ? { clientId: target.clientId } : {}),
    kind,
    note: note.trim(),
    outcome: outcome.trim() || null,
    occurredAt,
  };
}
