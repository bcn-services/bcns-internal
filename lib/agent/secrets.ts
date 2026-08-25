/**
 * secrets.ts — sealing and opening one Claude Code OAuth token.
 *
 * Pure crypto over node's built-in `crypto`. No Supabase, no env read at
 * import, no `server-only` import — so the tests exercise the real thing with
 * no server and no database.
 *
 * The threat this addresses is narrow and worth naming so nobody mistakes it
 * for more: a database dump, a backup file, a screenshot of a table browser. A
 * reader who has the droplet's environment has AGENT_TOKEN_KEY and can open
 * every row, and that is fine — that reader already has the running process
 * that spawns agents with those tokens. Encryption at rest separates the
 * database's blast radius from the host's, nothing further.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/** AES-256-GCM: 32-byte key, 12-byte nonce (the size GCM is defined for), 16-byte tag. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope version. It is the first field so an opener can reject an unknown
 * format before touching any of the bytes after it. A future rotation to a
 * different cipher adds `v2` and keeps this branch, rather than changing what
 * `v1` means underneath rows already written.
 */
const VERSION = "v1";

/** Guards against a pasted token that is really a whole file or a stack trace. */
const MAX_TOKEN_CHARS = 4096;

export class AgentKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyError";
  }
}

/**
 * The sealing key, read at CALL time so the app still imports and builds with
 * nothing configured. Base64 or base64url of exactly 32 bytes — generate one
 * with `openssl rand -base64 32`.
 *
 * Throws rather than returning null: every caller of this is already inside a
 * "the employee asked to enroll or run" path, and a silent null there would
 * become a confusing failure two frames later.
 */
export function agentKey(): Buffer {
  const raw = process.env.AGENT_TOKEN_KEY?.trim();
  if (!raw) throw new AgentKeyError("AGENT_TOKEN_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    // Never echo the value, not even its prefix.
    throw new AgentKeyError(
      `AGENT_TOKEN_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * A stable, non-secret name for the key currently configured, stored beside
 * each row so a run can say "sealed under a key this host no longer has"
 * instead of "decryption failed".
 *
 * It is the first 8 hex of a keyed digest OF the key, not of the key material
 * verbatim — the input to the hash is the key, so the output must not be a
 * useful oracle. HMAC with a fixed label makes it a one-way, domain-separated
 * label rather than a plain hash an attacker could compare against a candidate
 * list... which, for a 256-bit random key, they could not anyway. The label is
 * belt and braces, and it costs one line.
 */
export function agentKeyId(key: Buffer = agentKey()): string {
  return createHmac("sha256", key).update("bcns/agent-token-key-id").digest("hex").slice(0, 8);
}

/**
 * Seal a token. Output is `v1.<iv>.<tag>.<ciphertext>`, every part base64url,
 * so the whole thing is a single URL- and JSON-safe string and the database
 * column stays plain `text`.
 *
 * The nonce is fresh per call. Reusing one under the same key breaks GCM
 * catastrophically — it is not a "weaker" failure, it leaks the keystream — so
 * there is no seam here for a caller to supply one.
 */
export function sealToken(plaintext: string, key: Buffer = agentKey()): string {
  const token = plaintext.trim();
  if (!token) throw new AgentKeyError("Refusing to seal an empty token");
  if (token.length > MAX_TOKEN_CHARS) {
    throw new AgentKeyError(`Token is longer than ${MAX_TOKEN_CHARS} characters`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

/**
 * Open a sealed token, or throw. Every failure — wrong key, tampered
 * ciphertext, truncated envelope, unknown version — arrives here as a throw
 * with a message safe to log, and never with any part of the plaintext.
 *
 * GCM authenticates before it decrypts, so a modified row fails rather than
 * yielding a corrupted token that would then be sent to Anthropic.
 */
export function openToken(sealed: string, key: Buffer = agentKey()): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new AgentKeyError("Sealed token is malformed");
  const [version, ivB64, tagB64, bodyB64] = parts as [string, string, string, string];
  if (version !== VERSION) throw new AgentKeyError(`Unknown sealed-token version: ${version}`);

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new AgentKeyError("Sealed token has a bad nonce or tag length");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([
      decipher.update(Buffer.from(bodyB64, "base64url")),
      decipher.final(),
    ]);
    return out.toString("utf8");
  } catch {
    // The library's own message names the cipher and the failure mode; ours
    // says the only thing an operator can act on.
    throw new AgentKeyError("Could not open the sealed token — wrong key or tampered data");
  }
}

