import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  beginClobOrderSubmission,
  clobOrderSubmissionActive,
  installClobHttpTransport,
  resolveClobHttpSettings,
  warmClobConnection,
} from "./clobHttpTransport.js";

describe("CLOB dedicated HTTP transport", () => {
  test("bounds keep-alive and warmer settings", () => {
    const settings = resolveClobHttpSettings({
      CLOB_KEEPALIVE_TIMEOUT_MS: "1",
      CLOB_REQUEST_SOCKET_TIMEOUT_MS: "999999",
      CLOB_PRECONNECT_INTERVAL_MS: "999999",
      CLOB_PRECONNECT_REQUEST_TIMEOUT_MS: "1",
      CLOB_KEEPALIVE_MAX_SOCKETS: "3.9",
    });
    assert.equal(settings.socketTimeoutMs, 10_000);
    assert.equal(settings.activeSocketTimeoutMs, 30_000);
    assert.equal(settings.intervalMs, 2_500);
    assert.equal(settings.warmTimeoutMs, 250);
    assert.equal(settings.maxSockets, 3);
  });

  test("scopes the transport to HTTPS CLOB origins", () => {
    assert.throws(() => installClobHttpTransport("http://clob.invalid"), /must be HTTPS/);
    assert.doesNotThrow(() => installClobHttpTransport("https://clob.invalid"));
  });

  test("gives an order priority over new background warm requests", async () => {
    const release = beginClobOrderSubmission();
    assert.equal(clobOrderSubmissionActive(), true);
    const result = await warmClobConnection({ host: "https://clob-priority.invalid", force: true });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, "order-priority");
    release();
    release();
    assert.equal(clobOrderSubmissionActive(), false);
  });
});
