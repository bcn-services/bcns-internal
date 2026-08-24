/**
 * clients/[slug]/page.tsx — one client, joined to the account it came from.
 *
 * The split is deliberate: `clients` holds delivery facts, `accounts` holds
 * who they are and what they are worth. This page is where the two meet, which
 * is why every field renders in one <dl> — the reader should not have to know
 * which table a fact came out of.
 *
 * THE TWO MONEY ROWS ARE ADMIN-ONLY, and they are dropped rather than dashed
 * out — a row reading "—" tells a member there is a number being kept from
 * them. Both are active income here: the monthly rate is what this client
 * bills, and by the time an account has a client row its deal value is closed
 * revenue rather than the open quote it was on /leads. Everything else on this
 * page is delivery work, and a member needs all of it.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getClientBySlug, getAccount, isValidSlug, centsToDollars } from "@/lib/accounts";
import { getViewer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // A malformed slug is a 404, not a 500 — the data layer would throw.
  if (!isValidSlug(slug)) notFound();

  const { role, client: db } = await getViewer();
  if (!db) notFound();
  const isAdmin = role === "admin";

  const client = await getClientBySlug(db, slug);
  if (!client) notFound();
  const account = await getAccount(db, client.account_id);

  return (
    <main>
      <h1>{account?.business_name ?? client.slug}</h1>
      <dl>
        <dt>Status</dt><dd>{client.status}</dd>
        <dt>Slug</dt><dd>{client.slug}</dd>
        {/* NULL is "never recorded", not "free" — see 0006_seed_clients.sql. */}
        {isAdmin && (
          <>
            <dt>Monthly</dt>
            <dd>
              {client.monthly_rate_cents == null
                ? "—"
                : `$${centsToDollars(client.monthly_rate_cents)}`}
            </dd>
          </>
        )}
        <dt>Domain</dt><dd>{client.domain ?? "—"}</dd>
        <dt>Business type</dt><dd>{account?.business_type ?? "—"}</dd>
        <dt>City</dt><dd>{account?.city ?? "—"}</dd>
        <dt>Contact</dt><dd>{account?.contact_name ?? "—"}</dd>
        <dt>Phone</dt><dd>{account?.phone ?? "—"}</dd>
        <dt>Website</dt><dd>{account?.website ?? "—"}</dd>
        {isAdmin && (
          <>
            <dt>Deal value</dt>
            <dd>
              {account?.deal_value_cents == null
                ? "—"
                : `$${centsToDollars(account.deal_value_cents)}`}
            </dd>
          </>
        )}
        <dt>Closed</dt><dd>{account?.close_date ?? "—"}</dd>
      </dl>
      <p><Link href="/clients">Back to clients</Link></p>
    </main>
  );
}
