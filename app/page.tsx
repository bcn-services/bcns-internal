/**
 * page.tsx — the front door. What the automation has to say this morning, then
 * what is on your plate today.
 *
 * Both children are server components that never block the render: the briefing
 * card returns whatever row already exists rather than waiting on an agent, and
 * `Today` reads its own rows. A slow or missing either one degrades to an empty
 * section, never to a spinner and never to a 500.
 */
import Today from "./today";
import BriefingCard from "./briefing-card";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  return (
    <main>
      <h1>Home</h1>
      <BriefingCard />
      <Today />
    </main>
  );
}
