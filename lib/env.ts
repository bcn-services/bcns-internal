/**
 * env.ts — Single, lazy accessor for all runtime configuration.
 *
 * Every value is read from process.env at CALL TIME, never at module import.
 * This keeps the app buildable and importable when no keys are set: nothing
 * here throws or reads env as a side effect of `import`. Missing values come
 * back as `undefined` and each consumer decides how to degrade gracefully.
 */

/** Read a single env var, trimming and treating empty/whitespace as unset. */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Coerce a truthy env flag ("1", "true", "yes", case-insensitive) to boolean. */
function readFlag(name: string): boolean {
  const v = readEnv(name)?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * A port number, or undefined if unset or not a sane port. A bad value comes
 * back undefined rather than NaN, so `getMailer` treats it as "not configured"
 * and falls back to the no-op instead of handing nodemailer a NaN port.
 */
function readPort(name: string): number | undefined {
  const raw = readEnv(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

export interface AppConfig {
  /** Direct Postgres connection string (Supabase project database). */
  databaseUrl?: string;
  /** Supabase project URL — browser-safe. */
  supabaseUrl?: string;
  /** Supabase anon key — browser-safe, subject to RLS. */
  supabaseAnonKey?: string;
  /**
   * Supabase service-role key — server-only. Bypasses RLS; must never be
   * referenced from any client-side code path.
   */
  supabaseServiceRoleKey?: string;
  anthropicApiKey?: string;
  /** Master switch for the opt-in AI module. Default OFF. */
  aiEnabled: boolean;
  /**
   * Resend's API key. Unset. Resend is NOT needed for the notices this system
   * sends — every one of them goes to a bcns employee, so the bot mailbox on
   * Google Workspace (the SMTP fields below) carries them. Resend's separate
   * subdomain and DKIM exist for COLD OUTREACH to leads, which nothing here
   * sends yet. Keep the two transports apart: a complaint spiral on outreach
   * must not be able to reach the mailbox that carries internal notices.
   */
  resendApiKey?: string;
  /** The From: address a configured provider sends as, e.g. bot@bcn-services.com. */
  mailFrom?: string;
  /**
   * SMTP for the bot mailbox. `smtp.gmail.com` port 465 for Google Workspace.
   * `smtpPass` is a Google APP PASSWORD, never the account password — an app
   * password is scoped to one app and revocable on its own.
   */
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  /**
   * Who "Nate" is, for the notices addressed to the admin by role. Overridable
   * so a literal address is never wired into business logic; the fallback below
   * is the one named constant the item allows.
   */
  notifyAdminEmail: string;
  /**
   * Addresses an adapter may actually be handed, comma-separated. Anything else
   * is rendered and recorded but never passed to `send`. It exists so a
   * half-configured provider cannot mail a real customer.
   */
  notifyAllowedRecipients: string[];
}

/**
 * The one hardcoded address in the system, and it is configuration rather than
 * business logic: `notifyAdminEmail` resolves to a `profiles` row by email, and
 * everything downstream works from that profile. It is also the only address
 * the send allowlist permits by default — the item's designated test address.
 */
export const DEFAULT_ADMIN_EMAIL = "nseluga@g.hmc.edu";

/**
 * Build the config snapshot from the current environment. Call this inside
 * request handlers / server components, not at module top level, so tests and
 * builds that run without env vars never trip over a missing value.
 */
export function getConfig(): AppConfig {
  return {
    databaseUrl: readEnv("DATABASE_URL"),
    supabaseUrl: readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    anthropicApiKey: readEnv("ANTHROPIC_API_KEY"),
    aiEnabled: readFlag("AI_ENABLED"),
    resendApiKey: readEnv("RESEND_API_KEY"),
    mailFrom: readEnv("MAIL_FROM"),
    smtpHost: readEnv("SMTP_HOST"),
    smtpPort: readPort("SMTP_PORT"),
    smtpUser: readEnv("SMTP_USER"),
    smtpPass: readEnv("SMTP_PASS"),
    notifyAdminEmail: readEnv("NOTIFY_ADMIN_EMAIL") ?? DEFAULT_ADMIN_EMAIL,
    notifyAllowedRecipients: (readEnv("NOTIFY_ALLOWED_RECIPIENTS") ?? DEFAULT_ADMIN_EMAIL)
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length > 0),
  };
}
