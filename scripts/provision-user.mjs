#!/usr/bin/env node
/**
 * provision-user.mjs — create a bcns staff account, or fix an existing one.
 *
 *   npm run provision-user -- nate@bcn-services.com admin
 *   npm run provision-user -- brandon@bcn-services.com admin
 *   npm run provision-user -- someone@bcn-services.com member
 *
 * Why a script and not the dashboard: the role lives in `app_metadata`, which
 * the Supabase user editor does not expose, so the dashboard route is "add the
 * user, then hand-write SQL against auth.users". That is two steps with an
 * order dependency, repeated per hire. This is one command and is idempotent —
 * run it again to change somebody's role.
 *
 * ORDER MATTERS, and this script is why you do not have to remember it. The
 * role is baked into the JWT when the session is minted. Setting it after
 * sign-in leaves the person holding a roleless token, gated out of an app whose
 * database says they are an admin. Provision first, sign in second.
 *
 * It also prints a working sign-in link. Supabase's built-in SMTP is rate
 * limited to a handful of mails an hour and is the usual reason a first login
 * never happens; the printed link needs no mail at all.
 *
 * Uses the service-role key, which BYPASSES RLS. Correct for an operator
 * running this by hand, wrong for anything the app serves.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

/** Exactly the strings lib/auth.ts resolveRole() accepts. Anything else gates out. */
const ROLES = ["admin", "member"];

function loadEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] === undefined) process.env[k] = v.trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* absent .env.local is fine when the values come from the environment */ }
}

function die(msg) {
  console.error(`provision-user: ${msg}`);
  process.exit(1);
}

/** Deliberately loose: the identity provider is the real validator. */
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function findByEmail(db, email) {
  // supabase-js has no get-user-by-email, so page through. A bcns-sized team
  // fits in one page many times over; the loop is here so it stays correct.
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) die(`could not list users: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === wanted);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  const [email, role = "admin", displayNameArg, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const appUrl = process.env.APP_URL || "http://localhost:3100";

  if (!email) die(`usage: npm run provision-user -- <email> [admin|member] ["Display Name"]`);
  if (rest.length) die(`unexpected extra argument: ${rest[0]}`);
  if (!looksLikeEmail(email)) die(`${JSON.stringify(email)} does not look like an email address`);
  if (!ROLES.includes(role)) die(`role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`);

  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) die("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const existing = await findByEmail(db, email);
  let user;
  if (existing) {
    const before = existing.app_metadata?.role ?? "(none)";
    // Merge rather than replace: app_metadata also holds the provider fields
    // Supabase manages, and clobbering those breaks the account.
    const { data, error } = await db.auth.admin.updateUserById(existing.id, {
      app_metadata: { ...existing.app_metadata, role },
    });
    if (error) die(`could not update ${email}: ${error.message}`);
    user = data.user;
    console.log(`updated ${email}: role ${before} -> ${role}`);
  } else {
    const { data, error } = await db.auth.admin.createUser({
      email,
      // Without this the account sits unconfirmed and the sign-in link dies on
      // arrival. There is no password to confirm — sign-in is by link.
      email_confirm: true,
      app_metadata: { role },
    });
    if (error) die(`could not create ${email}: ${error.message}`);
    user = data.user;
    console.log(`created ${email} with role ${role}`);
  }

  // Read back rather than trusting the write. This is the exact field the gate
  // reads, so if it is wrong here the person cannot get in, and better to learn
  // that now than at the login screen.
  const { data: check, error: checkErr } = await db.auth.admin.getUserById(user.id);
  if (checkErr) die(`could not verify: ${checkErr.message}`);
  const got = check.user.app_metadata?.role;
  if (got !== role) die(`role did not stick: app_metadata.role is ${JSON.stringify(got)}`);
  console.log(`verified app_metadata.role = ${got}`);

  // The profile row is what the app can actually read — auth.users lives in the
  // `auth` schema, which PostgREST does not expose, so without this the person
  // can sign in but cannot be displayed or assigned anything.
  //
  // display_name defaults to the local part of the email because a placeholder
  // that is obviously a placeholder ("nate") beats an empty picker entry. It is
  // editable later; the column only exists so the UI has something to render.
  const displayName = displayNameArg ?? email.split("@")[0];
  const { error: profileErr } = await db
    .from("profiles")
    .upsert({ id: user.id, email, display_name: displayName }, { onConflict: "id" });
  if (profileErr) {
    // Not fatal: sign-in still works, and the row can be added by hand. Say so
    // loudly rather than dying, so a directory problem never blocks a login.
    console.log(`WARNING: could not write the profile row (${profileErr.message}).`);
    console.log(`${email} can sign in but will not appear in assignment pickers.`);
  } else {
    console.log(`profile: ${displayName} <${email}>`);
  }

  const { data: link, error: linkErr } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${appUrl}/auth/callback` },
  });
  if (linkErr) {
    console.log(`\nCould not mint a sign-in link (${linkErr.message}).`);
    console.log(`Sign in at ${appUrl}/login and request one by email instead.`);
    return;
  }

  // NOT action_link. That URL points at Supabase's own /auth/v1/verify, which
  // verifies server-side and then redirects with the tokens in the URL FRAGMENT
  // (#access_token=...). A fragment is never sent to the server, so our route
  // handler sees no query params at all and fails with missing_code.
  //
  // hashed_token is the same one-time token unwrapped. Handing it straight to
  // our own callback lets verifyOtp run server-side and write real session
  // cookies, which is what the SSR middleware reads.
  const signIn = `${appUrl}/auth/callback?token_hash=${link.properties.hashed_token}&type=magiclink`;
  console.log(`\nSign-in link (single use, expires — do not share):\n\n${signIn}\n`);
  console.log(`Or sign in normally at ${appUrl}/login .`);
}

main().catch((e) => die(e?.message ?? String(e)));
