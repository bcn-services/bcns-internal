/**
 * admin/page.tsx — the staff directory.
 *
 * Gated to admins by the middleware (lib/auth.ts ADMIN_PREFIX), so there is no
 * role check to repeat here; the `role !== "admin"` branch below is a belt on
 * top of the braces, for the case where the gate is somehow bypassed.
 *
 * There is deliberately NO "create user" form. Creating an auth user needs the
 * service-role key, which bypasses RLS entirely — a page that could reach it
 * would be one XSS or one leaked bundle away from handing out the database.
 * Provisioning therefore stays a terminal command run by an operator.
 */
import { getViewer } from "@/lib/supabase-server";
import { listProfiles } from "@/lib/profiles";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { role, client: db } = await getViewer();

  if (role !== "admin") {
    return (
      <main>
        <h1>Admin</h1>
        <p role="alert">This page is for administrators.</p>
      </main>
    );
  }

  const profiles = db ? await listProfiles(db) : [];

  return (
    <main>
      <h1>Admin</h1>

      <h2>Staff</h2>
      <p>{profiles.length} {profiles.length === 1 ? "person" : "people"}.</p>
      <section>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{p.display_name}</td>
                <td>{p.email}</td>
                <td>{p.active ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {profiles.length === 0 && <p>Nobody is provisioned yet.</p>}

      <h2>Adding someone</h2>
      <p>Run this from the repo, then send them the sign-in link it prints:</p>
      <pre><code>npm run provision-user -- someone@bcn-services.com member &quot;Their Name&quot;</code></pre>
      <p>
        It is a terminal command and not a button because it needs the
        service-role key, which bypasses RLS and must never be shipped to a page.
      </p>
    </main>
  );
}
