/**
 * agent-secrets.test.mjs — sealing and opening one employee's Claude token.
 *
 * What is worth testing here is not that AES works. It is the envelope around
 * it, because that is what this repo wrote: the version prefix, the fresh
 * nonce per call, the key-length check, and — the one that actually protects
 * anything — that a tampered row fails closed instead of yielding a corrupted
 * token that would then be sent to Anthropic as a credential.
 *
 * The key is set per test rather than read from the environment. These tests
 * must not depend on a developer having AGENT_TOKEN_KEY configured, and they
 * must not pass because a real one happened to be present.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { agentKey, agentKeyId, sealToken, openToken, AgentKeyError } from "../lib/agent/secrets.ts";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const TOKEN = "sk-ant-oat01-not-a-real-token-0123456789";

let saved;
beforeEach(() => {
  saved = process.env.AGENT_TOKEN_KEY;
  process.env.AGENT_TOKEN_KEY = KEY_A;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_TOKEN_KEY;
  else process.env.AGENT_TOKEN_KEY = saved;
});

describe("agent token sealing", () => {
  test("a sealed token opens back to itself", () => {
    assert.equal(openToken(sealToken(TOKEN)), TOKEN);
  });

  test("the ciphertext never contains the plaintext", () => {
    // The point of the table column. If this ever fails, the encryption is
    // decorative and a database dump is a credential dump.
    assert.ok(!sealToken(TOKEN).includes(TOKEN));
    assert.ok(!sealToken(TOKEN).includes("sk-ant"));
  });

  test("sealing twice gives two different ciphertexts", () => {
    // A fresh nonce per call. Reusing one under the same key does not weaken
    // GCM, it breaks it — so this is a correctness test, not a nicety.
    assert.notEqual(sealToken(TOKEN), sealToken(TOKEN));
  });

  test("the envelope is versioned and base64url", () => {
    const parts = sealToken(TOKEN).split(".");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], "v1");
    // base64url so the whole value is safe in JSON, a URL, and a text column.
    for (const part of parts.slice(1)) assert.match(part, /^[A-Za-z0-9_-]+$/);
  });

  test("another key cannot open it", () => {
    const sealed = sealToken(TOKEN);
    process.env.AGENT_TOKEN_KEY = KEY_B;
    assert.throws(() => openToken(sealed), AgentKeyError);
  });

  test("a tampered ciphertext fails rather than decrypting to garbage", () => {
    const parts = sealToken(TOKEN).split(".");
    const body = Buffer.from(parts[3], "base64url");
    body[0] ^= 0xff;
    parts[3] = body.toString("base64url");
    assert.throws(() => openToken(parts.join(".")), AgentKeyError);
  });

  test("a swapped authentication tag fails", () => {
    const a = sealToken(TOKEN).split(".");
    const b = sealToken(TOKEN).split(".");
    a[2] = b[2];
    assert.throws(() => openToken(a.join(".")), AgentKeyError);
  });

  test("an unknown version is refused before the bytes are touched", () => {
    const parts = sealToken(TOKEN).split(".");
    parts[0] = "v2";
    assert.throws(() => openToken(parts.join(".")), /Unknown sealed-token version/);
  });

  test("a truncated envelope is refused", () => {
    assert.throws(() => openToken("v1.abc"), /malformed/);
  });

  test("an empty token is never sealed", () => {
    assert.throws(() => sealToken("   "), /empty/);
  });
});

describe("the key itself", () => {
  test("a missing key is a named error, not a crash somewhere later", () => {
    delete process.env.AGENT_TOKEN_KEY;
    assert.throws(() => agentKey(), /AGENT_TOKEN_KEY is not set/);
  });

  test("a short key is refused", () => {
    process.env.AGENT_TOKEN_KEY = Buffer.alloc(16).toString("base64");
    assert.throws(() => agentKey(), /must decode to 32 bytes/);
  });

  test("the key error never echoes the key", () => {
    const secret = randomBytes(20).toString("base64");
    process.env.AGENT_TOKEN_KEY = secret;
    try {
      agentKey();
      assert.fail("expected a throw");
    } catch (err) {
      assert.ok(!err.message.includes(secret));
      assert.ok(!err.message.includes(secret.slice(0, 8)));
    }
  });

  test("the key id identifies the key without revealing it", () => {
    const a = agentKeyId();
    process.env.AGENT_TOKEN_KEY = KEY_B;
    const b = agentKeyId();
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
    // It is a digest of the key, so it must not be a prefix of the key.
    assert.ok(!KEY_A.includes(a));
  });

  test("the key id is stable for one key", () => {
    assert.equal(agentKeyId(), agentKeyId());
  });
});
