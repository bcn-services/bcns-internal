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
  return (
    <main>
      <h1>bcns internal</h1>
      <p>Sign in with your work email. No password — we email you a link.</p>
      <SignInForm next={next} />
    </main>
  );
}
