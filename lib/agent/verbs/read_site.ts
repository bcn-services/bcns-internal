/**
 * read_site — fetch one URL and hand back readable text.
 *
 * This is the verb with no database behind it and therefore no RLS behind it
 * either. Everything that keeps it safe is in this file, so it is written to be
 * read rather than to be short.
 *
 * FOUR BOUNDS, ALL OF THEM LOAD-BEARING:
 *
 *  1. TIMEOUT. A hung server must not hang the agent. The abort surfaces as a
 *     typed `timeout`, never as a promise that never settles.
 *
 *  2. SIZE CAP. The body is read INCREMENTALLY and the read is abandoned once
 *     the cap is passed. Checking Content-Length would be theatre — it is
 *     advisory and a hostile server simply omits it.
 *
 *  3. SCHEME + HOST. http/https only (no `file:`, no `data:`), and by default
 *     no loopback / link-local / RFC1918 host. A URL arriving here may have
 *     been written by a model, which makes an unguarded fetcher an SSRF gadget
 *     aimed at the droplet's own localhost services and cloud metadata
 *     endpoint. Tests opt in via ctx.allowPrivateHosts to reach their fixture.
 *
 *  4. NO PAGE-DRIVEN NAVIGATION. This verb fetches exactly the URL it was
 *     given. It never follows a link, form action, refresh directive, or any
 *     other URL that came out of the page it just read — that is how a fetched
 *     page turns into the thing choosing the next request. HTTP redirects ARE
 *     followed, but manually, capped, and re-checked against the same scheme
 *     and host rules at every hop, so a redirect cannot walk out of the policy.
 *
 * ponytail: the host check is on the literal hostname, so a public name whose
 * DNS answer is 127.0.0.1 gets through. Closing that needs resolve-then-pin-
 * the-socket (a custom undici dispatcher). Upgrade when this verb is ever
 * pointed at a URL a stranger supplied rather than one an operator or a lead
 * record did.
 */

import { defineVerb, fail, ok, type VerbResult } from "./types";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 40_000;
const MAX_REDIRECTS = 3;

export interface ReadSiteInput {
  url: string;
  timeoutMs?: number;
}

export interface ReadSiteResult {
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  text: string;
  truncated: boolean;
}

/** Hostnames a fetch must not reach unless a caller explicitly opts in. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "" || h === "::1") return true;
  if (h === "0.0.0.0" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  return false;
}

function checkUrl(raw: string, allowPrivate: boolean): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `not a URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `read_site only fetches http and https, not ${url.protocol}` };
  }
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    return { error: `refusing to fetch a private or loopback host: ${url.hostname}` };
  }
  return { url };
}

/** HTML → text. Blunt on purpose; this feeds a model, not a renderer. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|title)\b[\s\S]*?<\/\1>/gi, " ")
    // Block-level tags become newlines so paragraphs do not run together.
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(stripped)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: titleMatch?.[1] ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || null : null,
    text,
  };
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** Read at most `max` bytes, then stop pulling. Returns whether it was cut short. */
async function readCapped(res: Response, max: number): Promise<{ body: string; truncated: boolean }> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    // A fake fetch (or a body-less response) — take the text and cut it.
    const whole = await res.text();
    return whole.length > max
      ? { body: whole.slice(0, max), truncated: true }
      : { body: whole, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      size += value.byteLength;
      if (size >= max) {
        truncated = true;
        break;
      }
    }
  } finally {
    // Stop the transfer rather than draining a 4GB response into /dev/null.
    await reader.cancel().catch(() => undefined);
  }
  return { body: Buffer.concat(chunks).toString("utf8").slice(0, max), truncated };
}

export const read_site = defineVerb<ReadSiteInput, ReadSiteResult>({
  name: "read_site",
  description:
    "Fetch one http/https URL and return its readable text. Enforces a timeout and a response " +
    "size cap, and never follows links found in the page it fetched.",
  roles: ["admin", "member"],
  properties: {
    url: { type: "string", description: "The absolute http or https URL to read." },
    timeoutMs: {
      type: "integer",
      description: `How long to wait (default ${DEFAULT_TIMEOUT_MS}ms, cap ${MAX_TIMEOUT_MS}ms).`,
    },
  },
  required: ["url"],
  async handler(ctx, input): Promise<VerbResult<ReadSiteResult>> {
    const allowPrivate = ctx.allowPrivateHosts === true;
    const first = checkUrl(String(input.url ?? ""), allowPrivate);
    if ("error" in first) return fail("invalid_input", first.error);

    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.min(Math.floor(input.timeoutMs), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    const doFetch = ctx.fetchImpl ?? fetch;
    const controller = new AbortController();
    // The deadline spans the WHOLE call, redirects included — a per-hop timer
    // would let a redirect chain stall for MAX_REDIRECTS × timeoutMs.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let current = first.url;
    try {
      for (let hop = 0; ; hop++) {
        let res: Response;
        try {
          res = await doFetch(current.toString(), {
            redirect: "manual",
            signal: controller.signal,
            headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.5", "user-agent": "bcns-agent/1.0" },
          });
        } catch (err) {
          if (controller.signal.aborted) {
            return fail("timeout", `read_site: no response from ${current.hostname} within ${timeoutMs}ms`);
          }
          const message = err instanceof Error ? err.message : String(err);
          return fail("network_error", `read_site: cannot reach ${current.hostname} — ${message}`);
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) return fail("network_error", `read_site: ${res.status} with no Location header`);
          if (hop >= MAX_REDIRECTS) return fail("network_error", "read_site: too many redirects");
          // Re-check every hop against the same policy: a redirect must not be
          // able to walk the fetch out of the scheme/host rules.
          const next = checkUrl(new URL(location, current).toString(), allowPrivate);
          if ("error" in next) return fail("forbidden", `read_site: redirect refused — ${next.error}`);
          current = next.url;
          continue;
        }

        if (!res.ok) {
          return fail("network_error", `read_site: ${current.toString()} returned HTTP ${res.status}`);
        }

        const { body, truncated } = await readCapped(res, MAX_BYTES);
        const type = res.headers.get("content-type") ?? "";
        const parsed = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(body)
          ? htmlToText(body)
          : { title: null, text: body.trim() };
        const text = parsed.text.slice(0, MAX_TEXT_CHARS);
        return ok({
          url: first.url.toString(),
          finalUrl: current.toString(),
          status: res.status,
          title: parsed.title,
          text,
          truncated: truncated || parsed.text.length > MAX_TEXT_CHARS,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  },
});
