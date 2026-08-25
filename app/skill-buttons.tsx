/**
 * skill-buttons.tsx — run a skill from the page where its work happens.
 *
 * WHICH buttons appear is decided on the server by `skillButtonsFor` in
 * lib/agent/skills.ts and handed down as a prop. This file renders whatever it
 * is given and never re-derives the list, so there is one place gating is
 * decided and a test of that function is a test of what renders.
 *
 * WHETHER a run is allowed is decided again, independently, by
 * POST /api/skills/run. Hiding a button is convenience; the route is the gate.
 *
 * A `fetch` with an AbortController rather than a server action, because a
 * server action call cannot be cancelled from a browser and this one has to
 * be: a skill run is up to 55 seconds. Cancel aborts the request, which closes
 * the connection, which fires `request.signal` on the server — where the run
 * is closed out as `cancelled`. Nothing here blocks the page: the rest of the
 * lead list stays live while a run is in flight, and only the buttons in THIS
 * group disable.
 *
 * No CSS of its own. <button>, <p role="alert"> and <p role="status"> are all
 * styled by element in app/globals.css.
 */
"use client";

import { useRef, useState } from "react";
import type { SkillButton } from "@/lib/agent/skills";

type Phase = { kind: "idle" } | { kind: "running"; skill: string };

export default function SkillButtons({
  buttons,
  accountId,
}: {
  buttons: SkillButton[];
  /** Which record the run is about. The server resolves it to a name. */
  accountId?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Nothing to show is nothing to render — no empty container, no stray gap.
  // This is what a developer (and anyone with no job_function) sees.
  if (buttons.length === 0) return null;

  async function start(skill: string, label: string) {
    if (phase.kind === "running") return;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setDone(null);
    setPhase({ kind: "running", skill });
    try {
      const res = await fetch("/api/skills/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill, ...(accountId ? { accountId } : {}) }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; notEnrolled?: boolean }
        | null;
      if (res.ok && body?.ok) {
        setDone(`${label}: done. The result is in your os.`);
      } else if (body?.notEnrolled) {
        setError("No Claude seat is connected yet — set one up on your account page.");
      } else {
        setError(body?.error ?? `That run failed (${res.status}).`);
      }
    } catch (err) {
      // An abort lands here too, and is not a failure worth shouting about.
      if ((err as { name?: string })?.name === "AbortError") setDone("Cancelled.");
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      abort.current = null;
      setPhase({ kind: "idle" });
    }
  }

  const running = phase.kind === "running";

  return (
    <div>
      {buttons.map((b) => (
        <button
          key={b.name}
          type="button"
          disabled={running}
          onClick={() => start(b.name, b.label)}
        >
          {running && phase.skill === b.name ? `${b.label}…` : b.label}
        </button>
      ))}

      {running && (
        <button type="button" onClick={() => abort.current?.abort()}>
          Cancel
        </button>
      )}

      {error && <p role="alert">{error}</p>}
      {done && <p role="status">{done}</p>}
    </div>
  );
}
