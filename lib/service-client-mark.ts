/**
 * service-client-mark.ts — a runtime tag on the service-role client.
 *
 * lib/supabase-admin.ts builds the ONE client that bypasses RLS. Data-layer
 * functions whose safety story is "RLS decides, the .eq is only an index hint"
 * are wrong the moment they are handed that client, and nothing in the type
 * system tells them apart — both are `SupabaseClient`. So the factory stamps
 * the client it returns and those functions refuse it.
 *
 * Symbol.for, not a field: it cannot collide with a PostgREST property and it
 * does not serialize.
 *
 * This module imports nothing — deliberately, so lib/inbox.ts can use it while
 * staying free of `server-only` and testable under plain node.
 */

export const SERVICE_ROLE_CLIENT = Symbol.for("bcns.serviceRoleClient");

/** Stamp a freshly built service-role client. Returns the same object. */
export function markServiceClient<T extends object>(client: T): T {
  Object.defineProperty(client, SERVICE_ROLE_CLIENT, { value: true, enumerable: false });
  return client;
}

export function isServiceClient(client: unknown): boolean {
  return (
    typeof client === "object" &&
    client !== null &&
    (client as Record<symbol, unknown>)[SERVICE_ROLE_CLIENT] === true
  );
}
