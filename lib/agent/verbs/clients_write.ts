/**
 * clients_write — change a client record, or convert a won lead into one.
 *
 * ADMIN ONLY, and that is not a convenience. 0002 gives `clients` no member
 * INSERT or UPDATE policy at all, so a member's attempt already dies at the
 * database. The gate here exists so it dies as a typed `forbidden` the model
 * can read, instead of as a PostgREST error string it has to guess at.
 *
 * `monthly_rate_cents` is accepted as DOLLARS and converted by the shared
 * `dollarsToCents` — money never crosses this boundary as a float.
 */

import {
  convertAccountToClient,
  dollarsToCents,
  isUuid,
  isValidSlug,
  type Client,
} from "../../accounts";
import { defineVerb, fail, ok, requireDb, type VerbResult } from "./types";

export interface ClientsWriteInput {
  slug?: string;
  status?: string;
  domain?: string | null;
  monthlyRateDollars?: string | number;
  /** Present => convert this won account into a new client. */
  fromAccountId?: string;
}

export const clients_write = defineVerb<ClientsWriteInput, Client>({
  name: "clients_write",
  description:
    "Admin only. Either convert a won lead into a client (give fromAccountId), or update an " +
    "existing client by slug (status, domain, monthly rate in dollars).",
  roles: ["admin"],
  properties: {
    slug: { type: "string", description: "Client slug to update, or the slug for a new client." },
    status: { type: "string", description: "New client status, e.g. 'active' or 'churned'." },
    domain: { type: "string", description: "The client's domain." },
    monthlyRateDollars: {
      type: "string",
      description: "Monthly retainer in dollars, e.g. '150' or '149.99'. Stored as integer cents.",
    },
    fromAccountId: {
      type: "string",
      description: "Account uuid to convert into a client. Omit when updating an existing client.",
    },
  },
  async handler(ctx, input): Promise<VerbResult<Client>> {
    const dbRes = requireDb(ctx, "clients_write");
    if (!dbRes.ok) return dbRes;
    const db = dbRes.data;

    if (input.fromAccountId !== undefined) {
      if (!isUuid(input.fromAccountId)) {
        return fail("invalid_input", `bad account id: ${input.fromAccountId}`);
      }
      return ok(
        await convertAccountToClient(db, {
          accountId: input.fromAccountId,
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
        }),
      );
    }

    if (!isValidSlug(input.slug)) return fail("invalid_input", `bad slug: ${String(input.slug)}`);

    const patch: Record<string, unknown> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.domain !== undefined) patch.domain = input.domain;
    if (input.monthlyRateDollars !== undefined) {
      patch.monthly_rate_cents = dollarsToCents(input.monthlyRateDollars);
    }
    if (Object.keys(patch).length === 0) {
      return fail("invalid_input", "clients_write needs at least one field to change");
    }

    const res = await db
      .from("clients")
      .update(patch)
      .eq("slug", input.slug)
      .select("id, account_id, slug, status, monthly_rate_cents, domain, created_at, updated_at")
      .maybeSingle();
    if (res.error) return fail("db_error", `clients_write: ${res.error.message}`);
    if (!res.data) return fail("not_found", `no client ${input.slug}`);
    return ok({ ...(res.data as Client), business_name: null });
  },
});
