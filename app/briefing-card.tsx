/**
 * briefing-card.tsx — the briefing on the front door.
 *
 * A server component that reads two indexed rows and renders whatever exists:
 * the newest briefing, a building state, or an empty state. It NEVER waits for
 * an agent. The trigger and the poll are the client half (briefing-refresh.tsx)
 * and run after this markup is already on screen — which is the whole delivery
 * contract: the page renders immediately and the card fills in.
 *
 * No CSS of its own. `<section>`, `<article>`, `<h2>`, `<p role="status">` and
 * `<time>` are all styled by element in app/globals.css; the one inline style
 * is `white-space: pre-wrap`, because the agent writes plain text with real
 * line breaks and there is no existing element that means "keep them".
 */
import { loadBriefingCard, type BriefingCard as Card } from "@/lib/briefing";
import { getViewer } from "@/lib/supabase-server";
import BriefingRefresh from "./briefing-refresh";

const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function BriefingCard() {
  const { userId, client: db } = await getViewer();

  let card: Card = { state: "none", latest: null, lastBriefedAt: null };
  let readFailed = false;
  try {
    card = await loadBriefingCard({ userId, db });
  } catch (err) {
    // A card that cannot read is a card that says so. It must not take the
    // front door down with it.
    console.warn("[briefing] card read failed:", err);
    readFailed = true;
  }

  return (
    <section aria-labelledby="briefing">
      <h2 id="briefing">Your briefing</h2>

      {readFailed && <p role="alert">Could not read your briefing.</p>}

      {card.state === "building" && (
        <p role="status">Writing your briefing — this takes up to a minute.</p>
      )}

      {card.latest ? (
        <article aria-busy={card.state === "building"}>
          <h3>
            <time dateTime={card.latest.created_at}>{when(card.latest.created_at)}</time>
          </h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{card.latest.body ?? card.latest.title}</p>
        </article>
      ) : (
        card.state !== "building" &&
        !readFailed && <p>No briefing yet. The next one covers everything from here.</p>
      )}

      {/* The trigger, the poll and the manual refresh. Rendered last so the
          briefing above is on screen before any of it runs. */}
      <BriefingRefresh state={card.state} at={card.latest?.created_at ?? null} />
    </section>
  );
}
