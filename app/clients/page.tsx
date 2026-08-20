/**
 * clients/page.tsx — every client bcns hosts, one row each.
 *
 * Reads through the RLS-governed client, so the list is exactly what this
 * viewer is permitted to see. No role check here: middleware already proved
 * the viewer is staff, and the database is the backstop.
 */
import Link from "next/link";
import { listClients } from "@/lib/accounts";
import { getViewer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const { client: db } = await getViewer();
  // Unconfigured environment (no Supabase keys): render the empty state
  // instead of a 500, matching the keyless contract the template holds to.
  const clients = db ? await listClients(db) : [];

  return (
    <main>
      <h1>Clients</h1>
      <p>{clients.length} hosted {clients.length === 1 ? "client" : "clients"}.</p>
      {clients.length === 0 ? (
        <p>No clients yet. Convert a won lead to create the first one.</p>
      ) : (
        <ul>
          {clients.map((c) => (
            <li key={c.id}>
              <Link href={`/clients/${c.slug}`}>{c.slug}</Link> — {c.status}
            </li>
          ))}
        </ul>
      )}
      <p><Link href="/leads">Leads</Link></p>
    </main>
  );
}
