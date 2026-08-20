/**
 * fetch-timeout.ts — a fetch that gives up.
 *
 * Why: getUser() runs in middleware on EVERY gated request. Without a bound, a
 * hung Supabase auth server does not fail the app — it makes every page hang
 * forever, which is worse than an outage because nothing reports it. An
 * abort surfaces as "no user", which the gate fails safe on.
 */

const DEFAULT_TIMEOUT_MS = 5000;

export function timeoutFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Respect a caller-supplied signal as well: whichever aborts first wins.
  init?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}
