import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClientIp, pseudonymizeVisitorValue } from "./visitorSessions";

test("normalizes proxied IPv4 addresses without retaining the forwarding chain", () => {
  assert.equal(normalizeClientIp("::ffff:203.0.113.12"), "203.0.113.12");
  assert.equal(normalizeClientIp("203.0.113.12, 10.0.0.4"), "203.0.113.12");
});

test("pseudonymizes IPs and sessions deterministically without exposing source values", () => {
  const secret = "test-session-secret";
  const ipHash = pseudonymizeVisitorValue("203.0.113.12", secret, "ip");
  const sessionHash = pseudonymizeVisitorValue("203.0.113.12", secret, "session");

  assert.equal(ipHash.length, 64);
  assert.equal(ipHash, pseudonymizeVisitorValue("203.0.113.12", secret, "ip"));
  assert.notEqual(ipHash, sessionHash);
  assert.equal(ipHash.includes("203.0.113.12"), false);
});