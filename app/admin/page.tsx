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
import { allEnrollments, daysUntilExpiry, EXPIRY_WARNING_DAYS } from "@/lib/agent/tokens";
import { skillButtonsFor } from "@/lib/agent/skills";
import SkillButtons from "../skill-buttons";

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

  // Who has connected a Claude seat. Read through the service role because
  // `agent_tokens` has no RLS policies at all — see 0008_agent_tokens.sql. An
  // admin sees exactly what an employee sees about their own enrollment: that
  // it exists, when it was last used, when it lapses. Never the token.
  //
  // A failure here degrades the column to "unknown" rather than taking the
  // staff directory down with it; the directory is the older, more important
  // half of this page.
  let seats = new Map<string, { lastUsedAt: string | null; days: number }>();
  let seatError = false;
  try {
    seats = new Map(
      (await allEnrollments()).map((e) => [
        e.profileId,
        { lastUsedAt: e.lastUsedAt, days: daysUntilExpiry(e) },
      ]),
    );
  } catch (err) {
    console.error("[admin] could not read agent seats:", err);
    seatError = true;
  }

  return (
    <main>
      <h1>Admin</h1>

      {/* Admin-only by role, so job_function is not consulted: a null or
          `developer` job_function must not strip an admin of their own
          controls. Role grants these; job_function only ever narrows the
          member-visible sets. */}
      <SkillButtons buttons={skillButtonsFor("admin", role, null)} />

      <h2>Staff</h2>
      <p>{profiles.length} {profiles.length === 1 ? "person" : "people"}.</p>
      <section>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Active</th>
              <th>Agent seat</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{p.display_name}</td>
                <td>{p.email}</td>
                <td>{p.active ? "yes" : "no"}</td>
                <td>{seatCell(seatError, seats.get(p.id))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {profiles.length === 0 && <p>Nobody is provisioned yet.</p>}

      <p>
        <small>
          An <strong>agent seat</strong> is that person&rsquo;s own Claude
          token, which every skill button and scheduled job runs under. Only
          they can connect it, from <code>/account</code> — a seat cannot be
          set up on someone else&rsquo;s behalf, because the token comes from
          their own <code>claude setup-token</code>.
        </small>
      </p>

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

/** One cell of the agent-seat column. Kept out of the table body for legibility. */
function seatCell(
  failed: boolean,
  seat: { lastUsedAt: string | null; days: number } | undefined,
): string {
  if (failed) return "unknown";
  if (!seat) return "not connected";
  if (seat.days < 0) return "expired";
  const life = seat.days <= EXPIRY_WARNING_DAYS ? ` · expires in ${seat.days}d` : "";
  return (seat.lastUsedAt ? `used ${new Date(seat.lastUsedAt).toLocaleDateString()}` : "never used") + life;
}
