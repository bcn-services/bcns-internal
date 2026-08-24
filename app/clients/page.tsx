/**
 * clients/page.tsx — every client bcns hosts, one row each.
 *
 * Reads through the RLS-governed client, so the list is exactly what this
 * viewer is permitted to see. No role check here: middleware already proved
 * the viewer is staff, and the database is the backstop.
 *
 * A table, not a list: rate is money and belongs in a column that lines up
 * under the rate above it.
 */
import Link from "next/link";
import { centsToDollars, listClients } from "@/lib/accounts";
import type { Client } from "@/lib/accounts";
import { getViewer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const { client: db } = await getViewer();
  // Unconfigured environment (no Supabase keys): render the empty state
  // instead of a 500, matching the keyless contract the template holds to.
  const clients: Client[] = db ? await listClients(db) : [];

  return (
    <main>
      <h1>Clients</h1>
      <p>{clients.length} hosted {clients.length === 1 ? "client" : "clients"}.</p>
      {clients.length === 0 ? (
        <p>No clients yet. Convert a won lead to create the first one.</p>
      ) : (
        <section>
          <table>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Slug</th>
                <th scope="col">Status</th>
                <th scope="col">Monthly</th>
                <th scope="col">Domain</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.business_name ?? "—"}</th>
                  <td><Link href={`/clients/${c.slug}`}>{c.slug}</Link></td>
                  <td>{c.status}</td>
                  {/* A NULL rate means the number was never recorded, NOT that
                      the client is free. Rendering it as $0.00 would state a
                      commercial fact nobody entered. */}
                  <td>
                    {c.monthly_rate_cents == null
                      ? "—"
                      : `$${centsToDollars(c.monthly_rate_cents)}`}
                  </td>
                  <td>{c.domain ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p><Link href="/leads">Leads</Link></p>
    </main>
  );
}
