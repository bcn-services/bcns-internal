/**
 * clients/[slug]/page.tsx — one client, joined to the account it came from.
 *
 * The split is deliberate: `clients` holds delivery facts, `accounts` holds
 * who they are and what they are worth. This page is where the two meet.
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

  const { client: db } = await getViewer();
  if (!db) notFound();

  const client = await getClientBySlug(db, slug);
  if (!client) notFound();
  const account = await getAccount(db, client.account_id);

  return (
    <main>
      <h1>{account?.business_name ?? client.slug}</h1>
      <p>Status: {client.status}</p>
      <dl>
        <dt>Slug</dt><dd>{client.slug}</dd>
        <dt>City</dt><dd>{account?.city ?? "—"}</dd>
        <dt>Phone</dt><dd>{account?.phone ?? "—"}</dd>
        <dt>Website</dt><dd>{account?.website ?? "—"}</dd>
        <dt>Deal value</dt>
        <dd>
          {account?.deal_value_cents == null
            ? "—"
            : `$${centsToDollars(account.deal_value_cents)}`}
        </dd>
        <dt>Closed</dt><dd>{account?.close_date ?? "—"}</dd>
      </dl>
      <p><Link href="/clients">Back to clients</Link></p>
    </main>
  );
}
