/**
 * login/page.tsx — placeholder sign-in page.
 *
 * Release 1 gates every other route; this page is the redirect target so the
 * gate has somewhere to send an anonymous visitor. Real email sign-in lands
 * with the Supabase Auth wiring — see docs/NEXT_STEPS.
 */
export default function LoginPage() {
  return (
    <main>
      <h1>bcns internal</h1>
      <p>Sign-in is not wired up yet. Ask Nate for an invite.</p>
    </main>
  );
}
