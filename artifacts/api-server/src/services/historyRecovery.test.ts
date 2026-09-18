import test from "node:test";
import assert from "node:assert/strict";
import { verifiedEmailKeys, verifiedEmailsMatch } from "./historyRecovery";

function identity(options: {
  email?: string;
  verified?: boolean;
  provider?: string;
  providerUserId?: string;
}) {
  return {
    emailAddresses: options.email ? [{
      emailAddress: options.email,
      verification: { status: options.verified ? "verified" : "unverified" },
    }] : [],
    externalAccounts: options.provider && options.providerUserId ? [{
      provider: options.provider,
      providerUserId: options.providerUserId,
    }] : [],
  } as any;
}

test("matches the same verified email without depending on case", () => {
  const current = identity({ email: "Owner@Example.com", verified: true });
  const legacy = identity({ email: "owner@example.com", verified: true });

  assert.equal(verifiedEmailsMatch(current, legacy), true);
  assert.deepEqual([...verifiedEmailKeys(current)], ["email:owner@example.com"]);
});

test("does not match unverified or unrelated email addresses", () => {
  const current = identity({ email: "owner@example.com", verified: true });

  assert.equal(
    verifiedEmailsMatch(current, identity({ email: "owner@example.com", verified: false })),
    false,
  );
  assert.equal(
    verifiedEmailsMatch(current, identity({ email: "someone-else@example.com", verified: true })),
    false,
  );
});