/**
 * clients_query — read paying clients.
 *
 * THE MONEY CASE. `clients.monthly_rate_cents` is what a client pays. A member
 * gets rows with that key ABSENT — not null, absent — and an admin gets it.
 * The stripping is done once by `defineVerb`/`stripMoney` in types.ts on the
 * way out; this file selects the column unconditionally and does no redaction
 * of its own, which is the point: a second copy of the rule is a second thing
 * that can drift.
 */

import { getClientBySlug, listClients, isValidSlug, type Client } from "../../accounts";
import { defineVerb, fail, ok, requireDb, type VerbResult } from "./types";

export interface ClientsQueryInput {
  slug?: string;
}

export const clients_query = defineVerb<ClientsQueryInput, Client[]>({
  name: "clients_query",
  description:
    "Read bcns clients, by slug or all of them. Each row carries the originating account's " +
    "business name. The monthly rate is included only for an admin caller.",
  roles: ["admin", "member"],
  properties: {
    slug: { type: "string", description: "A single client slug, e.g. 'coventry'." },
  },
  async handler(ctx, input): Promise<VerbResult<Client[]>> {
    const dbRes = requireDb(ctx, "clients_query");
    if (!dbRes.ok) return dbRes;

    if (input.slug !== undefined) {
      if (!isValidSlug(input.slug)) return fail("invalid_input", `bad slug: ${input.slug}`);
      const row = await getClientBySlug(dbRes.data, input.slug);
      return row ? ok([row]) : fail("not_found", `no client ${input.slug}`);
    }
    return ok(await listClients(dbRes.data));
  },
});
