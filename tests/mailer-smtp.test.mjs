/**
 * mailer-smtp.test.mjs — the SMTP transport behind the bot mailbox.
 *
 * THE POINT OF THE FILE is that a HALF-configured mailbox must behave exactly
 * like an UNCONFIGURED one. That distinction is not cosmetic: `configured:false`
 * parks the email in `email_outbox` as `pending` (retryable once someone
 * finishes the setup), while `configured:true` records it as `failed` (a
 * provider's verdict). Getting it backwards means a missing password silently
 * buries mail as permanently failed.
 *
 * What this file does NOT prove: that a real message reaches a real inbox.
 * That needs a live mailbox and a live credential, neither of which exists in a
 * test. The success path is verified once, by hand, per docs/NOTIFICATIONS.md.
 * The failure path below is real: it opens an actual TCP connection to a closed
 * port and asserts on what comes back.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { getMailer, smtpMailer, nullMailer } from "../lib/mailer.ts";
import { getConfig } from "../lib/env.ts";

const SMTP_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "MAIL_FROM",
];

const FULL = {
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: "465",
  SMTP_USER: "bot@bcn-services.com",
  SMTP_PASS: "app-password-not-a-real-one",
  MAIL_FROM: "bcns bot <bot@bcn-services.com>",
};

function setEnv(vars) {
  for (const k of SMTP_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

afterEach(() => setEnv({}));

describe("getMailer selects a transport from the environment", () => {
  test("no configuration at all hands back the no-op", () => {
    setEnv({});
    assert.equal(getMailer().name, "none");
    assert.equal(getMailer(), nullMailer);
  });

  test("a complete configuration hands back SMTP", () => {
    setEnv(FULL);
    assert.equal(getMailer().name, "smtp");
  });

  // The heart of the file: every single-field omission, not just one.
  for (const missing of SMTP_KEYS) {
    test(`missing ${missing} falls back to the no-op, not a broken SMTP`, () => {
      const partial = { ...FULL };
      delete partial[missing];
      setEnv(partial);
      assert.equal(
        getMailer().name,
        "none",
        `${missing} unset must read as "not configured"`,
      );
    });
  }

  test("an empty-string value counts as unset, not as a valid credential", () => {
    setEnv({ ...FULL, SMTP_PASS: "   " });
    assert.equal(getMailer().name, "none");
  });

  test("a non-numeric port counts as unset rather than becoming NaN", () => {
    setEnv({ ...FULL, SMTP_PORT: "not-a-port" });
    assert.equal(getConfig().smtpPort, undefined);
    assert.equal(getMailer().name, "none");
  });

  test("an out-of-range port counts as unset", () => {
    setEnv({ ...FULL, SMTP_PORT: "70000" });
    assert.equal(getConfig().smtpPort, undefined);
    assert.equal(getMailer().name, "none");
  });

  test("a valid port is read as a number, not a string", () => {
    setEnv(FULL);
    assert.equal(getConfig().smtpPort, 465);
  });
});

describe("the no-op refuses in the way the outbox depends on", () => {
  test("it never throws, and reports configured:false", async () => {
    const r = await nullMailer.send({ to: "a@b.c", subject: "s", body: "b" });
    assert.equal(r.ok, false);
    assert.equal(r.configured, false);
  });
});

describe("smtpMailer against a real socket", () => {
  test("a refused connection reports configured:true, so the row is failed not pending", async () => {
    // Bind a port, learn its number, then close it — that guarantees nothing is
    // listening on a port we know, without guessing one that might be in use.
    const probe = net.createServer();
    await new Promise((res) => probe.listen(0, "127.0.0.1", res));
    const port = probe.address().port;
    await new Promise((res) => probe.close(res));

    const mailer = smtpMailer({
      host: "127.0.0.1",
      port,
      user: "u",
      pass: "p",
      from: "bot@bcn-services.com",
    });
    const r = await mailer.send({ to: "a@b.c", subject: "s", body: "b" });

    assert.equal(r.ok, false);
    assert.equal(
      r.configured,
      true,
      "a provider that exists and failed is not the same as no provider",
    );
    assert.ok(r.error.length > 0, "the reason must be recorded, not swallowed");
  });

  test("it reports its name as smtp, for the log line", () => {
    const mailer = smtpMailer({
      host: "h",
      port: 465,
      user: "u",
      pass: "p",
      from: "f@x.com",
    });
    assert.equal(mailer.name, "smtp");
  });
});
