/**
 * /chat — ask a question about what the dashboard knows.
 *
 * This is NOT the Astro ChatPanel. That was a 1,300-line client island driving
 * a tool-calling agent scoped to $OS_DIR on one laptop: it read files, streamed
 * over SSE, and kept its transcript in sessionStorage. None of that survives the
 * move to a server — there is no laptop to read, and a company app should not
 * ship a filesystem agent to a browser.
 *
 * What is here instead: one question, one answer, over the data this app already
 * has. Deliberately skipped, and worth adding only if someone asks for it:
 *   * streaming — the answer appears when it is done
 *   * a transcript — each question stands alone, which is why the question
 *     lives in the URL and the page is shareable and refresh-safe
 *   * tools — the model sees a summary assembled below, and cannot go looking
 *
 * The whole page is gated on AI_ENABLED. Off is the default, and off says so
 * rather than rendering a box that fails on submit.
 */
import Link from "next/link";
import { getViewer } from "@/lib/supabase-server";
import { isAiEnabled, maybeGetAiClient } from "@/lib/ai";
import { STAGES, centsToDollars } from "@/lib/accounts";
import { funnelCounts, type AccountPoint } from "@/lib/insights";

export const dynamic = "force-dynamic";

const MAX_QUESTION = 500;
const MAX_ANSWER_TOKENS = 800;

const SYSTEM = [
  "You answer questions about bcns's internal dashboard for bcns staff.",
  "Answer only from the DASHBOARD DATA below. It is the whole of what you know.",
  "If the data does not contain the answer, say so plainly and name what is missing.",
  "Never invent a business name, a number, or a date. Be brief.",
].join(" ");

export default async function ChatPage({
  searchParams,
}: {
  searchParams?: { q?: string | string[] };
}) {
  const raw = searchParams?.q;
  const question = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const enabled = isAiEnabled();

  let answer: string | null = null;
  let error: string | null = null;

  if (enabled && question) {
    try {
      if (question.length > MAX_QUESTION) {
        throw new Error(`Keep the question to ${MAX_QUESTION} characters or fewer.`);
      }
      const client = maybeGetAiClient();
      if (!client) throw new Error("AI is enabled but no ANTHROPIC_API_KEY is set.");

      const context = await buildContext();
      const reply = await client.messages.create({
        // The client carries the app's default model; naming it here would be
        // a second place to change on a model migration.
        model: (client as unknown as { defaultModel: string }).defaultModel,
        max_tokens: MAX_ANSWER_TOKENS,
        system: SYSTEM,
        messages: [{ role: "user", content: `DASHBOARD DATA\n${context}\n\nQUESTION\n${question}` }],
      });
      // Narrowed by the discriminant rather than by a hand-written predicate:
      // the SDK's TextBlock carries more than {type, text}, so a predicate
      // spelling out the shape drifts every time the SDK adds a field.
      answer = reply.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim() || "The model returned nothing.";
    } catch (e) {
      console.error("[chat] failed:", e);
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <main>
      <h1>Chat</h1>

      {!enabled ? (
        <p>
          AI is switched off. Set <code>AI_ENABLED=1</code> and{" "}
          <code>ANTHROPIC_API_KEY</code> to turn this page on.
        </p>
      ) : (
        <>
          {/* GET, not a server action: the question belongs in the URL so the
              page is shareable and a refresh re-asks rather than re-posts. */}
          <form method="get" action="/chat">
            <label>
              Ask about the leads, the clients, or the projects
              <input name="q" defaultValue={question} maxLength={MAX_QUESTION} required />
            </label>
            <button type="submit">Ask</button>
          </form>

          {error && <p role="alert"><strong>Could not answer:</strong> {error}</p>}

          {answer && (
            <article>
              <h2>Answer</h2>
              {/* Split on blank lines rather than rendering the model's text as
                  markup. A model reply is untrusted text, not HTML. */}
              {answer.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
              <p><small>One question at a time — this page keeps no transcript.</small></p>
            </article>
          )}
        </>
      )}

      <p><Link href="/clients">Clients</Link> · <Link href="/leads">Leads</Link></p>
    </main>
  );
}

/**
 * The entire world the model gets: aggregate counts and the client list, never
 * raw account rows. A summary rather than a dump is the point — it keeps the
 * prompt small, and it keeps every lead's phone number out of a third party.
 */
async function buildContext(): Promise<string> {
  const { client: db } = await getViewer();
  if (!db) return "The database is not configured. No data is available.";

  const [accounts, clients] = await Promise.all([
    db.from("accounts").select("status, deal_value_cents"),
    db.from("clients").select("slug, status, monthly_rate_cents, domain"),
  ]);
  if (accounts.error) throw new Error(accounts.error.message);
  if (clients.error) throw new Error(clients.error.message);

  const accountRows = (accounts.data ?? []) as AccountPoint[];
  const funnel = funnelCounts(accountRows, STAGES)
    .map((f) => `  ${f.stage}: ${f.count}`)
    .join("\n");

  const clientRows = (clients.data ?? []) as {
    slug: string; status: string; monthly_rate_cents: number | null; domain: string | null;
  }[];
  const clientList = clientRows.length === 0
    ? "  (none)"
    : clientRows.map((c) =>
        `  ${c.slug} — ${c.status}` +
        (c.monthly_rate_cents != null ? `, $${centsToDollars(c.monthly_rate_cents)}/mo` : "") +
        (c.domain ? `, ${c.domain}` : "")).join("\n");

  return [
    `Accounts by funnel stage (${accountRows.length} total):`, funnel,
    `Clients (${clientRows.length} total):`, clientList,
  ].join("\n");
}
