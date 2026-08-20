/**
 * leads/page.tsx — the funnel. Every account that is not yet a client, plus
 * the ones that are, with the actions that move them.
 *
 * Forms post to server actions in ./actions.ts. No client-side JavaScript is
 * required for any of it, which is why the buttons are plain form submits.
 */
import Link from "next/link";
import { listAccounts, STAGES, centsToDollars, type Stage } from "@/lib/accounts";
import { getViewer } from "@/lib/supabase-server";
import { advanceStage, addNote, convertLead } from "./actions";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;
  const filter = (STAGES as readonly string[]).includes(status ?? "")
    ? (status as Stage)
    : undefined;

  const { role, client: db } = await getViewer();
  const accounts = db ? await listAccounts(db, filter ? { status: filter } : {}) : [];

  return (
    <main>
      <h1>Leads</h1>
      {/* Set by a server action that failed — a permission denial, usually. */}
      {error && <p role="alert"><strong>Could not save:</strong> {error}</p>}
      <nav>
        <Link href="/leads">All</Link>
        {STAGES.map((s) => (
          <span key={s}> · <Link href={`/leads?status=${s}`}>{s}</Link></span>
        ))}
      </nav>
      <p>{accounts.length} shown{filter ? ` in ${filter}` : ""}.</p>

      {accounts.length === 0 && <p>Nothing here yet.</p>}

      {accounts.map((a) => (
        <article key={a.id}>
          <h2>{a.business_name}</h2>
          <p>
            {a.business_type ?? "—"} · {a.city ?? "—"} · {a.phone ?? "no phone"} ·{" "}
            {a.has_website ? "has a website" : "no website"} · score {a.lead_score ?? "—"} ·{" "}
            {a.call_count} {a.call_count === 1 ? "call" : "calls"} · stage <strong>{a.status}</strong>
            {a.deal_value_cents != null && ` · $${centsToDollars(a.deal_value_cents)}`}
          </p>

          <form action={advanceStage}>
            <input type="hidden" name="accountId" value={a.id} />
            <label>
              Move to{" "}
              <select name="status" defaultValue={a.status}>
                {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <button type="submit">Save stage</button>
          </form>

          <form action={addNote}>
            <input type="hidden" name="accountId" value={a.id} />
            <select name="kind" defaultValue="call">
              <option value="call">call</option>
              <option value="email">email</option>
              <option value="note">note</option>
              <option value="meeting">meeting</option>
            </select>
            <input name="note" placeholder="What happened?" />
            <button type="submit">Log contact</button>
          </form>

          {/* Shown to admins only. A member who forges this post is still
              stopped by RLS — the UI hide is convenience, not the control. */}
          {role === "admin" && a.status === "won" && (
            <form action={convertLead}>
              <input type="hidden" name="accountId" value={a.id} />
              <input name="slug" placeholder="slug (optional)" />
              <input name="dealValue" placeholder="deal value in dollars" />
              <button type="submit">Convert to client</button>
            </form>
          )}
        </article>
      ))}

      <p><Link href="/clients">Clients</Link></p>
    </main>
  );
}
