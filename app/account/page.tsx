/**
 * /account — where an employee connects their own Claude seat.
 *
 * WHY THIS PAGE EXISTS AT ALL. Every agent run on the droplet spawns as a
 * specific person, using a token that person issued from their own bcns Claude
 * account. Nobody can enroll on anyone else's behalf, because `claude
 * setup-token` runs on the employee's own machine against their own login —
 * so the paste box has to be somewhere every employee can reach, which is why
 * this is not a section of /admin.
 *
 * WHAT THIS PAGE CANNOT DO. It never shows a token back, not even your own.
 * `agent_tokens` has RLS on and no policies, so the browser cannot read the
 * row at all; the server reads it through the service role and the only place
 * a decrypted token ever goes is a child process's environment. Revoking here
 * deletes the row, which stops this server acting as you — it does not revoke
 * the token at Anthropic, and the copy below says so rather than implying a
 * guarantee the app cannot make.
 */
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/supabase-server";
import {
  daysUntilExpiry,
  enrollToken,
  enrollmentFor,
  revokeToken,
  EXPIRY_WARNING_DAYS,
  type AgentEnrollment,
} from "@/lib/agent/tokens";

export const dynamic = "force-dynamic";

/** Server actions carry their outcome back in the URL — no client state. */
type Search = { saved?: string; revoked?: string; error?: string };

export default async function AccountPage({
  searchParams,
}: {
  searchParams?: Search;
}) {
  const { userId, email, role } = await getViewer();

  // Middleware has already gated this route, so a null id here means the
  // session evaporated between the gate and the render. Say so plainly rather
  // than rendering a form that cannot work.
  if (!userId) {
    return (
      <main>
        <h1>Account</h1>
        <p>Your session has expired. <Link href="/login">Sign in again</Link>.</p>
      </main>
    );
  }

  let enrollment: AgentEnrollment | null = null;
  let loadError: string | null = null;
  try {
    enrollment = await enrollmentFor(userId);
  } catch (err) {
    console.error("[account] could not read enrollment:", err);
    loadError = "Could not read your agent status.";
  }

  async function save(formData: FormData) {
    "use server";
    // The identity is re-read from the session inside the action rather than
    // passed in from the form. A hidden field naming the profile would be a
    // straight "enroll a token as your boss" hole.
    const { userId: actor } = await getViewer();
    if (!actor) redirect("/login");
    const token = String(formData.get("token") ?? "");

    // redirect() works by throwing, so the outcome is captured here and acted
    // on below — calling it inside the try would be swallowed by the catch.
    let failure: string | null = null;
    try {
      await enrollToken(actor, token);
    } catch (err) {
      // These messages come from lib/agent/tokens.ts and name only what the
      // employee can act on — never the token, never any part of the key.
      failure = err instanceof Error ? err.message : "Could not save that token.";
    }
    revalidatePath("/account");
    redirect(failure ? `/account?error=${encodeURIComponent(failure)}` : "/account?saved=1");
  }

  async function revoke() {
    "use server";
    const { userId: actor } = await getViewer();
    if (!actor) redirect("/login");

    let failure: string | null = null;
    try {
      await revokeToken(actor);
    } catch (err) {
      console.error("[account] revoke failed:", err);
      failure = "Could not revoke that token.";
    }
    revalidatePath("/account");
    redirect(failure ? `/account?error=${encodeURIComponent(failure)}` : "/account?revoked=1");
  }

  const days = enrollment ? daysUntilExpiry(enrollment) : null;

  return (
    <main>
      <h1>Account</h1>
      <p>
        Signed in as {email ?? "an unknown address"}
        {role ? ` · ${role}` : null}
      </p>

      <h2>Agent access</h2>
      <p>
        Your morning briefing runs a Claude agent on the server
        <strong>as you</strong>. That needs a token from your own
        bcns Claude account — run <code>claude setup-token</code> on your laptop
        and paste what it prints.
      </p>

      {searchParams?.error && <p role="alert"><strong>Could not save:</strong> {searchParams.error}</p>}
      {searchParams?.saved && <p>Token saved. Agent runs will now go out as you.</p>}
      {searchParams?.revoked && <p>Token revoked. The server can no longer run agents as you.</p>}
      {loadError && <p role="alert">{loadError}</p>}

      {enrollment ? (
        <>
          <dl>
            <dt>Connected</dt>
            <dd>{new Date(enrollment.createdAt).toLocaleDateString()}</dd>
            <dt>Last used</dt>
            <dd>
              {enrollment.lastUsedAt
                ? new Date(enrollment.lastUsedAt).toLocaleString()
                : "never"}
            </dd>
            <dt>Expires</dt>
            <dd>
              {new Date(enrollment.expiresAt).toLocaleDateString()}
              {days !== null && days <= EXPIRY_WARNING_DAYS && (
                <>
                  {" "}
                  <strong>
                    {days < 0 ? "— expired, re-connect below" : `— in ${days} days`}
                  </strong>
                </>
              )}
            </dd>
          </dl>
          {/*
            Shown even while connected, because this is also the re-enroll path:
            an expired token is replaced by pasting a new one over it.
          */}
          <TokenForm action={save} label="Replace token" />
          <form action={revoke}>
            <button type="submit">Revoke</button>
          </form>
          <p>
            <small>
              Revoking stops this server from acting as you. It does not revoke
              the token at Anthropic — if you think it leaked, remove it from
              your Claude account as well.
            </small>
          </p>
        </>
      ) : (
        <>
          <p>No Claude seat is connected yet, so agent features will not run for you.</p>
          <TokenForm action={save} label="Connect" />
        </>
      )}
    </main>
  );
}

/**
 * The paste box. `type="password"` so the value does not sit legible on a
 * shared screen, and autoComplete off so no password manager offers to keep a
 * copy of a machine credential.
 */
function TokenForm({
  action,
  label,
}: {
  action: (formData: FormData) => Promise<void>;
  label: string;
}) {
  return (
    <form action={action}>
      <label>
        Setup token
        <input
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="sk-ant-…"
        />
      </label>
      <button type="submit">{label}</button>
    </form>
  );
}
