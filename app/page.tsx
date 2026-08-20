/**
 * page.tsx — the front door. Everything here is gated by middleware, so anyone
 * who sees it is signed in and provisioned.
 */
import Link from "next/link";
import { getViewer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { role } = await getViewer();
  return (
    <main>
      <h1>bcns internal</h1>
      <p>Signed in as <strong>{role ?? "unprovisioned"}</strong>.</p>
      <ul>
        <li><Link href="/clients">Clients</Link> — everyone bcns hosts</li>
        <li><Link href="/leads">Leads</Link> — the funnel, and the actions that move it</li>
        <li><Link href="/projects">Projects</Link> — the os project board</li>
        <li><Link href="/files">Files</Link> — read-only browser over $OS_DIR</li>
        <li><Link href="/graph">Graph</Link> — the knowledge graph over $OS_DIR</li>
      </ul>
    </main>
  );
}
