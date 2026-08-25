/**
 * activity-capture.tsx — type what happened; approve what it became.
 *
 * The only client island on the lead and client pages. It has to be one: the
 * whole design is a two-step where the second step shows you what the first
 * produced, and a page that round-trips through the server between them loses
 * the thing being confirmed.
 *
 * ALL the logic is in ../lib/activity-capture.ts, which is plain TypeScript
 * with no React import. This file is the form. That split is why "the edited
 * values, not the parsed ones, are what get written" is a unit test rather
 * than a click-through.
 *
 * The timezone comes from the BROWSER (`Intl...resolvedOptions().timeZone`),
 * which is the only place the submitter's real local date exists — the server
 * runs in UTC, and resolving "Tuesday" there is the bug this guards.
 *
 * Styling is the page's own: <form>, <label>, <select>, <textarea> and
 * <button> are all styled by element in app/globals.css, so this adds no CSS.
 * `<details>` keeps it out of the way until someone wants it.
 */
"use client";

import { useReducer, useRef, useState } from "react";
import { HUMAN_KINDS, type ActivityKind } from "@/lib/agent/verbs/activity_query";
import {
  captureReducer,
  commitPayload,
  draftDateLocal,
  emptyCapture,
} from "@/lib/activity-capture";
import { commitActivity, parseActivity, type CaptureTarget } from "./activity/actions";
import type { VerbError } from "@/lib/agent/verbs/types";

/**
 * What to SAY about a failed parse. A full queue or a blown clock is the
 * server's capacity, not a judgement on somebody's words — telling a person
 * "could not read that text" when the real answer is "come back in a minute"
 * sends them off rewriting a note that was fine.
 */
function parseMessage(err: VerbError): string {
  if (err.code === "busy") {
    return "The reader is busy right now. Your words are still here — file it by hand, or try again in a moment.";
  }
  if (err.code === "timeout") {
    return "The reader took too long. Your words are still here — file it by hand, or try again.";
  }
  return err.message;
}

/** Resolved per render, not at module load: it is a browser fact. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export default function ActivityCapture({
  target,
  label = "Log activity",
}: {
  target: CaptureTarget;
  label?: string;
}) {
  const [state, dispatch] = useReducer(captureReducer, undefined, emptyCapture);
  const [done, setDone] = useState<string | null>(null);
  const timeZone = browserZone();
  /**
   * The submit latch. `state.busy` is read from the render's closure, so an
   * Enter-key resubmit before React re-renders sees the OLD false and both
   * handlers run — which on the commit path writes the row twice. A ref is the
   * same value without the closure, updated the instant the first submit starts.
   */
  const inFlight = useRef(false);

  async function onParse(e: React.FormEvent) {
    e.preventDefault();
    if (!state.text.trim() || state.busy || inFlight.current) return;
    inFlight.current = true;
    setDone(null);
    dispatch({ type: "parsing" });
    try {
      const res = await parseActivity(target, state.text, timeZone);
      // A failure NEVER drops the text — it opens the same confirmation step
      // with the raw words in the note, ready to file by hand.
      if (!res.ok || res.data.written !== false) {
        const message = res.ok ? "the parser returned no proposal" : parseMessage(res.error);
        dispatch({ type: "parse_failed", message, now: new Date() });
        return;
      }
      dispatch({ type: "parsed", proposal: res.data.proposal });
    } finally {
      inFlight.current = false;
    }
  }

  async function onCommit(e: React.FormEvent) {
    e.preventDefault();
    const payload = commitPayload(state, target);
    // The latch is checked BEFORE anything async: this is the double-write path.
    if (!payload || state.busy || inFlight.current) return;
    if (!payload.note) {
      dispatch({ type: "commit_failed", message: "The note is empty." });
      return;
    }
    inFlight.current = true;
    dispatch({ type: "committing" });
    try {
      const res = await commitActivity({ ...payload, ...target });
      if (!res.ok) {
        dispatch({ type: "commit_failed", message: res.error.message });
        return;
      }
      setDone(`Logged: ${payload.kind}.`);
      dispatch({ type: "committed" });
    } finally {
      inFlight.current = false;
    }
  }

  const draft = state.draft;

  return (
    <details>
      <summary>{label}</summary>

      {state.message && <p role="alert">{state.message}</p>}
      {done && <p role="status">{done}</p>}

      {state.step === "compose" || !draft ? (
        <form onSubmit={onParse}>
          <label>
            What happened?
            <textarea
              name="text"
              rows={2}
              value={state.text}
              disabled={state.busy}
              placeholder="called Mike at Coventry Tuesday, wants a quote by Friday"
              onChange={(ev) => dispatch({ type: "type", text: ev.target.value })}
            />
          </label>
          <button type="submit" disabled={state.busy || !state.text.trim()}>
            {state.busy ? "Reading…" : "Read it"}
          </button>
        </form>
      ) : (
        /* The confirmation step. Every field is editable, and what is submitted
           is what is on screen — the parse is a first draft, not a decision. */
        <form onSubmit={onCommit}>
          <p>
            <small>Check this over. Nothing is saved until you confirm.</small>
          </p>

          <label>
            Kind
            <select
              name="kind"
              value={draft.kind}
              disabled={state.busy}
              onChange={(ev) => dispatch({ type: "edit", field: "kind", value: ev.target.value })}
            >
              {HUMAN_KINDS.map((k: ActivityKind) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>

          <label>
            When
            <input
              type="date"
              name="occurredOn"
              value={draftDateLocal(draft, timeZone)}
              disabled={state.busy}
              onChange={(ev) => dispatch({ type: "edit_date", value: ev.target.value, timeZone })}
            />
          </label>

          <label>
            Outcome
            <input
              name="outcome"
              value={draft.outcome}
              disabled={state.busy}
              placeholder="how it went"
              onChange={(ev) => dispatch({ type: "edit", field: "outcome", value: ev.target.value })}
            />
          </label>

          <label>
            Note
            <textarea
              name="note"
              rows={3}
              value={draft.note}
              disabled={state.busy}
              onChange={(ev) => dispatch({ type: "edit", field: "note", value: ev.target.value })}
            />
          </label>

          <button type="submit" disabled={state.busy}>
            {state.busy ? "Saving…" : "Confirm and log"}
          </button>
          <button type="button" disabled={state.busy} onClick={() => dispatch({ type: "cancel" })}>
            Back
          </button>
        </form>
      )}
    </details>
  );
}
