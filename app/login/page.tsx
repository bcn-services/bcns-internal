/**
 * login/page.tsx — the gate's redirect target.
 *
 * Server component: it only sanitizes the destination the middleware stashed
 * in `?next=` and hands it to the client form.
 */
import { safeNext } from "@/lib/auth";
import { SignInForm } from "./sign-in-form";

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string | string[] };
}) {
  const raw = searchParams?.next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  // No shell wraps this route, so the page owns its own centring. Inline
  // styles, not a class: globals.css has no hook for a shell-less route.
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: "var(--s5)" }}>
      <main style={{ width: "100%", maxWidth: "26rem" }}>
        <h1>bcns internal</h1>
        <p>Sign in with your bcns Google account.</p>
        <SignInForm next={next} />
      </main>
    </div>
  );
}
