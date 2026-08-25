/**
 * briefing-refresh.tsx — the client half of the briefing card.
 *
 * THREE JOBS, ALL AFTER PAINT:
 *
 *   1. The login trigger. One POST on mount. The server decides whether that
 *      turns into a run — the 20-hour throttle is a conditional write in
 *      lib/briefing.ts, not a check here — so firing it on every mount is safe
 *      and this file holds no rule that could disagree with the server's.
 *   2. The poll. While a run is in flight, one small GET every POLL_MS asking
 *      only for a state and a timestamp. When the timestamp changes, the server
 *      component is re-rendered with `router.refresh()` and the poll stops.
 *   3. The manual refresh. The same POST with `force`, which shortens the
 *      throttle to the in-flight window rather than removing it.
 *
 * WHY POLLING. The alternatives were streaming (an open connection per tab for
 * a once-a-day event) and revalidate-on-tag (nothing to revalidate: the writer
 * is a background promise, not a request, and it has no router to refresh).
 * Polling costs at most one two-row read every few seconds for the 10–60
 * seconds a run lasts, and exactly nothing once the briefing has landed.
 *
 * The interval is cleared on unmount and on the first ready answer, so a tab
 * left open overnight polls nothing.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BriefingState } from "@/lib/briefing";

/** Slow enough to be free, fast enough that a 10s run does not feel stuck. */
const POLL_MS = 4_000;
/** A run that never lands must not poll forever. The card's own grace window. */
const MAX_POLLS = 200;

export default function BriefingRefresh({ state, at }: { state: BriefingState; at: string | null }) {
  const router = useRouter();
  const [phase, setPhase] = useState<BriefingState>(state);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(at);
  const triggered = useRef(false);

  // The login trigger. Once per mount, and never in React 18 StrictMode twice —
  // the ref is what makes a double-invoked effect one POST. The server would
  // refuse the second anyway; this just does not ask.
  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;
    let live = true;
    void fetch("/api/briefing", { method: "POST" })
      .then((res) => res.json())
      .then((body: { started?: boolean }) => {
        if (live && body?.started) setPhase("building");
      })
      .catch(() => {
        // A failed trigger is not worth a red banner on the front door: the
        // briefing is a convenience and the rest of the page is the work.
      });
    return () => {
      live = false;
    };
  }, []);

  // The poll. Runs only while something is being written.
  useEffect(() => {
    if (phase !== "building") return;
    let polls = 0;
    const id = setInterval(() => {
      if (++polls > MAX_POLLS) return clearInterval(id);
      void fetch("/api/briefing")
        .then((res) => res.json())
        .then((body: { state?: BriefingState; at?: string | null }) => {
          if (body?.at && body.at !== seen.current) {
            seen.current = body.at;
            setPhase("ready");
            router.refresh();
          } else if (body?.state && body.state !== "building") {
            setPhase(body.state);
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [phase, router]);

  async function refresh() {
    setError(null);
    setPhase("building");
    try {
      const res = await fetch("/api/briefing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const body = (await res.json().catch(() => null)) as { started?: boolean } | null;
      if (!body?.started) {
        setPhase(state);
        setError("A briefing is already being written — give it a minute.");
      }
    } catch (err) {
      setPhase(state);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <p>
      <button type="button" onClick={refresh} disabled={phase === "building"}>
        {phase === "building" ? "Writing…" : "Refresh briefing"}
      </button>
      {error && <span role="alert"> {error}</span>}
    </p>
  );
}
