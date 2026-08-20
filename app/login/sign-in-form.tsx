"use client";

/**
 * sign-in-form.tsx — magic-link sign-in. The only client component that talks
 * to Supabase directly.
 *
 * Sends the link to /auth/callback, which exchanges the code for a session
 * cookie and forwards to `next`. Styling is deliberately bare — visuals are a
 * later pass.
 */

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase-browser";

type Status = "idle" | "sending" | "sent" | "error";

export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = getBrowserClient();
    if (!client) {
      setStatus("error");
      setMessage("Supabase is not configured in this environment.");
      return;
    }
    setStatus("sending");
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error } = await client.auth.signInWithOtp({
      email,
      // No signups: accounts are provisioned in Supabase, and the role the gate
      // reads lives in app_metadata, which self-signup cannot set.
      options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
    });
    if (error) {
      setStatus("error");
      setMessage(error.message);
      return;
    }
    setStatus("sent");
    setMessage(`Check ${email} for a sign-in link.`);
  }

  if (status === "sent") return <p role="status">{message}</p>;

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="email">Work email</label>{" "}
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={status === "sending"}
      />{" "}
      <button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : "Email me a link"}
      </button>
      {status === "error" ? <p role="alert">{message}</p> : null}
    </form>
  );
}
