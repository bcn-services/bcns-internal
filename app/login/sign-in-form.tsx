"use client";

/**
 * sign-in-form.tsx — sign-in. The only client component that talks to Supabase
 * directly.
 *
 * Google Workspace is the only way in from this page. No email is sent, so
 * nothing depends on SMTP. Supabase redirects to /auth/callback with `?code=`,
 * and because the flow began in this browser the PKCE verifier is here to
 * complete it.
 *
 * This cannot create an account. The consent screen is Internal, so only
 * bcn-services.com Workspace accounts reach us at all. Even if one did, the
 * role the gate reads lives in app_metadata and no self-signup can set it, so a
 * stranger would land in an app whose every table returns nothing.
 *
 * The magic link is gone from the UI but not from the system: provision-user.mjs
 * still mints a `?token_hash=` link, and /auth/callback still verifies one. That
 * is the way back in on the day Google is unreachable — it just is not a button
 * a signed-out stranger can press.
 *
 * Styling is deliberately bare — visuals are a later pass.
 */

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase-browser";

type Status = "idle" | "sending" | "error";

export function SignInForm({ next }: { next: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function onGoogle() {
    const client = getBrowserClient();
    if (!client) {
      setStatus("error");
      setMessage("Supabase is not configured in this environment.");
      return;
    }
    setStatus("sending");
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // A hint to Google to skip the account chooser for other domains. It is
        // convenience only — the Internal consent screen is what actually keeps
        // non-bcns accounts out, because a hint travels in a URL anyone can edit.
        queryParams: { hd: "bcn-services.com" },
      },
    });
    // Only reached if the redirect never happened; success navigates away.
    if (error) {
      setStatus("error");
      setMessage(error.message);
    }
  }

  return (
    <>
      <button type="button" onClick={onGoogle} disabled={status === "sending"}>
        {status === "sending" ? "Redirecting…" : "Continue with Google"}
      </button>
      {status === "error" ? <p role="alert">{message}</p> : null}
    </>
  );
}
