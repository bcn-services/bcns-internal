/**
 * admin/panels.tsx — the two READ-ONLY panels on /admin, as plain components.
 *
 * WHY THEY ARE NOT IN page.tsx. `page.tsx` imports lib/supabase-server.ts,
 * which imports `server-only` and throws under plain node — so a test could
 * not import the page at all, and "the sealed token never appears in the
 * rendered output" would have to be asserted by reading JSX, which proves
 * nothing. Everything here takes plain props and renders, so
 * tests/admin-surface.test.mjs runs it through renderToStaticMarkup and greps
 * the real HTML. Same split, and the same reason, as lib/agent/skill-run.ts.
 *
 * THE TOKEN PANEL RENDERS NO TOKEN. It is handed `TokenPanelRow`s, a type with
 * no field that could hold one (lib/admin.ts), built field-by-field from the
 * enrollment rather than spread from it. There are three layers between a
 * sealed value and this file — `agent_tokens` is never selected with `sealed`,
 * `tokenPanelRows` never copies an unknown key, and `TokenPanelRow` has
 * nowhere to put one — and the test asserts the bytes, not the layers.
 *
 * THE RE-ENROLL CONTROL IS PROSE. It is a <details> block containing a command
 * for a human to type. It is not a form, not a button, and posts nowhere:
 * `claude setup-token` opens a browser and asks somebody to log in with their
 * own Anthropic account, which is not something a server can do on their
 * behalf and not something it should be able to.
 */

// Explicit React import: the classic JSX transform is what a plain-node test
// runner compiles this file with, and it needs `React` in scope.
import React from "react";

import type { JobRunRecord, TokenPanelRow } from "@/lib/admin";
import { runMeaning, runTone, tokenSummary } from "@/lib/admin";

/** `data-tone` drives the colour; see the admin block in app/globals.css. */
const TOKEN_TONE = {
  ok: "ok",
  expiring: "attention",
  expired: "bad",
  none: "neutral",
} as const;

const TOKEN_WORD = {
  ok: "connected",
  expiring: "expiring",
  expired: "EXPIRED",
  none: "not connected",
} as const;

const day = (iso: string | null) =>
  iso ? new Date(iso).toISOString().slice(0, 10) : "—";

/* ================================================================ tokens == */

export function TokenPanel({ rows }: { rows: readonly TokenPanelRow[] }) {
  const stopped = rows.filter((r) => r.state === "expired" || r.state === "none");

  return (
    <section>
      <h2>Agent seats</h2>
      <p>
        Every scheduled job and every skill button runs under the token of the
        person it belongs to. <strong>There is no fallback.</strong> When
        somebody&rsquo;s token lapses, their jobs stop until they re-enroll —
        the server does not quietly run their work on an admin&rsquo;s
        credential, because a run attributed to them that somebody else paid
        for is a lie in the audit trail.
      </p>

      {stopped.length > 0 && (
        <p role="alert">
          {stopped.length} {stopped.length === 1 ? "person has" : "people have"} no
          working seat. Their jobs are not running.
        </p>
      )}

      <table>
        <caption>Status and expiry only. The token itself is never shown here or anywhere else.</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Seat</th>
            <th scope="col">Expires</th>
            <th scope="col">Last used</th>
            <th scope="col">What that means</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.profileId}>
              <th scope="row">{r.name}</th>
              <td data-tone={TOKEN_TONE[r.state]}>{TOKEN_WORD[r.state]}</td>
              <td data-admin-only>{day(r.expiresAt)}</td>
              <td>{day(r.lastUsedAt)}</td>
              <td>{tokenSummary(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p>Nobody is provisioned yet.</p>}

      <ReEnrollInstructions />
    </section>
  );
}

/**
 * The re-enroll control: instructions, and nothing else.
 *
 * It cannot perform, initiate, or proxy a login. `claude setup-token` runs on
 * the person's own machine, opens their own browser, and authenticates their
 * own Anthropic account — there is no version of it a server can run for
 * somebody, and a button here that appeared to would either be a lie or a
 * credential-sharing hole. So the control is the sentence that tells them what
 * to type, and the only link is to their own /account page, where the paste
 * box already lives.
 */
function ReEnrollInstructions() {
  return (
    <details>
      <summary>How somebody re-enrolls (you cannot do it for them)</summary>
      <p>
        Send them these three steps. Nothing on this page can run them — the
        command opens their browser and signs into their own Anthropic account,
        so only they can complete it.
      </p>
      <ol>
        <li>
          Run <code>claude setup-token</code> in a terminal and finish the
          browser sign-in it opens.
        </li>
        <li>Copy the whole <code>sk-ant-…</code> value it prints.</li>
        <li>
          Paste it into the box on <a href="/account">their own /account page</a>.
          It replaces the old seat; nothing else has to change.
        </li>
      </ol>
      <p>
        <small>
          If a token leaked rather than lapsed, they also have to revoke it on
          their Anthropic account. Nothing here can do that either.
        </small>
      </p>
    </details>
  );
}

/* =========================================================== job history == */

/**
 * What the automation has been doing, newest first.
 *
 * THE STATUS COLUMN IS THE POINT OF THIS PANEL, and it is why item 9's
 * conflation had to be fixed before this page could exist: a nightly sweep
 * that ran perfectly and found one client's site down used to be written as
 * `failed`, so this table would have shown a healthy system as a broken one
 * every single night — and a status column everyone learns to ignore is worse
 * than no status column. `attention` and `failed` are now separate rows in
 * lib/agent/skill-run.ts's vocabulary, and the sentence under each says which.
 */
export function JobHistory({ runs }: { runs: readonly JobRunRecord[] }) {
  return (
    <section>
      <h2>Job history</h2>
      <p>
        The last {runs.length} run{runs.length === 1 ? "" : "s"}, newest first.
        <strong> Needs attention</strong> means the run itself was fine and
        found something; <strong>failed</strong> means the run did not come
        back and we do not know what it would have found.
      </p>

      {runs.length === 0 && <p>Nothing has run yet.</p>}

      {runs.map((r) => (
        <article key={r.id}>
          <h3>
            {r.job}{" "}
            <span data-tone={runTone(r.status)}>
              {r.status === "attention" ? "needs attention" : r.status}
            </span>
          </h3>
          <p>
            <small>{runMeaning(r.status)}</small>
          </p>
          <dl>
            <div>
              <dt>Started</dt>
              <dd>{new Date(r.started_at).toISOString().replace("T", " ").slice(0, 16)}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>
                {r.finished_at
                  ? new Date(r.finished_at).toISOString().replace("T", " ").slice(0, 16)
                  : "still open"}
              </dd>
            </div>
            <div>
              <dt>Triggered by</dt>
              <dd>{r.actor ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>{r.window_key ?? "on demand"}</dd>
            </div>
          </dl>
          {/* Collapsed: a log is long, and forty of them open at once is not a
              history page. `scrub` (lib/agent/verbs/types.ts) has already been
              over every string that reaches job_runs.log. */}
          <details>
            <summary>Log</summary>
            <pre>
              <code>{r.log ?? "(no log)"}</code>
            </pre>
          </details>
        </article>
      ))}
    </section>
  );
}
