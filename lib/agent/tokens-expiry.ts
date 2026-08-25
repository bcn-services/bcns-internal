/**
 * tokens-expiry.ts — the one number two surfaces have to agree on.
 *
 * A LEAF, for the same reason lib/job-windows.ts is one: lib/agent/tokens.ts
 * imports `server-only` and so cannot be imported by lib/admin.ts (which is
 * keyless and driven by tests under plain node) or by anything the middleware
 * touches. Copying the constant into the admin layer would be a second thing
 * to change, and the failure mode of forgetting is silent: the account page
 * warns at 30 days and the admin panel warns at 14, and nobody notices until
 * somebody's jobs stop.
 */

/** How long before expiry a page starts nagging about a Claude seat. */
export const EXPIRY_WARNING_DAYS = 30;
