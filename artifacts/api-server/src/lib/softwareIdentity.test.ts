import test from "node:test";
import assert from "node:assert/strict";
import { classifyComparisonOption } from "./comparisonClassification";
import { determineMarketEligibility, marketEligibilityProduct } from "./analysis";
import {
  forgetSoftwareIdentity, priorSoftwareIdentity, rememberSoftwareIdentity, softwareDomainForCategory,
  softwareIdentityFromDocument,
} from "./softwareIdentity";

const checkedAt = "2026-09-28T12:00:00.000Z";
const categories = [
  ["CRM / Marketing Platform", "customer engagement platform"],
  ["Digital Experience Platforms", "digital experience platform"],
  ["ERP", "enterprise resource planning platform"],
  ["Content Management System", "content management system"],
  ["Project Management Platform", "project management platform"],
  ["Collaboration Platform", "collaboration platform"],
  ["Analytics Platform", "analytics platform"],
  ["Data Platform", "data platform"],
  ["Identity Platform", "identity platform"],
  ["Cloud Platform", "cloud platform"],
] as const;

test("governed product documents resolve opaque commercial software identities across category families", () => {
  for (const [index, [category, phrase]] of categories.entries()) {
    const option = `Cygnetics${index}`;
    const url = `https://${option.toLowerCase()}.com/products`;
    const document = {
      url, finalUrl: url, contentType: "text/html",
      text: `${option} is a ${phrase} for teams. Request a demo to get started.`,
      sha256: `${index}`.repeat(64), retrievedAt: checkedAt, truncated: false,
    };
    assert.ok(softwareDomainForCategory(category));
    assert.equal(classifyComparisonOption(option).type, "unknown", `${option} has no hardcoded pattern`);
    assert.equal(determineMarketEligibility(option, category, "Australia", [], checkedAt).status, "UNKNOWN");
    const proof = softwareIdentityFromDocument(option, category, document, checkedAt);
    assert.ok(proof, `${category} exact owner, category, commercial CTA and hash`);
    const current = determineMarketEligibility(option, category, "Australia",
      [{ url, document }], checkedAt);
    assert.equal(current.status, "ELIGIBLE", `${category} current proof`);
    assert.equal(priorSoftwareIdentity(option), undefined, "buyer-provided documents do not seed the shared cache");
    rememberSoftwareIdentity(proof!); // Only independently discovered permission-checked proofs are shared.
    assert.equal(classifyComparisonOption(option).decisionDomain, proof!.domain);
    const timedOut = determineMarketEligibility(option, category, "India",
      [{ url, reason: "timeout" }], checkedAt);
    assert.equal(timedOut.status, "ELIGIBLE", `${category} survives timeout in another market`);
    assert.equal(timedOut.evidenceStatus, "TIMED_OUT");
    assert.equal(timedOut.newCustomerStatus, "UNKNOWN");
    assert.equal(determineMarketEligibility(option, "Home loans", "Australia", [], checkedAt).status, "UNKNOWN");
    assert.equal(priorSoftwareIdentity(option, proof!.domain, "2026-11-01T12:00:00.000Z"), undefined,
      "stale proof does not establish availability forever");
  }
});

test("invented names and weak documents cannot establish commercial software participation", () => {
  const option = "Neverbuilt42";
  const category = "ERP";
  const url = "https://neverbuilt42.com/erp";
  const base = { finalUrl: url, sha256: "a".repeat(64), retrievedAt: checkedAt };
  assert.equal(softwareIdentityFromDocument(option, category,
    { ...base, text: `${option} is an enterprise resource planning platform.` }, checkedAt), undefined,
  "product mention without a commercial offer is not enough");
  assert.equal(softwareIdentityFromDocument(option, category,
    { ...base, text: `${option} is an enterprise resource planning platform. Request a demo.` },
    "2026-11-01T12:00:00.000Z"), undefined, "stale documents cannot establish current commercial status");
  assert.equal(softwareIdentityFromDocument(option, category,
    { ...base, finalUrl: "https://unrelated.com/erp", text: `${option} is an enterprise resource planning platform. Request a demo.` },
    checkedAt), undefined, "another publisher cannot establish product identity");
  assert.equal(softwareIdentityFromDocument(option, category,
    { ...base, text: `${option} is an enterprise resource planning platform. Request a demo. Product sunset.` },
    checkedAt), undefined, "closure prevents active proof");
  assert.equal(determineMarketEligibility(option, category, "Australia",
    [{ url, reason: "timeout" }], checkedAt).status, "UNKNOWN");
});

test("explicit closure invalidates previously trusted software participation", () => {
  const option = "Axiomora";
  const category = "ERP";
  const url = "https://axiomora.com/erp";
  const document = {
    url, finalUrl: url, contentType: "text/html",
    text: "Axiomora is an ERP platform. Request a demo.",
    sha256: "e".repeat(64), retrievedAt: checkedAt, truncated: false,
  };
  const proof = softwareIdentityFromDocument(option, category, document, checkedAt);
  assert.ok(proof);
  rememberSoftwareIdentity(proof!);
  assert.equal(marketEligibilityProduct("Compare Axiomora and Cygnetics2 for ERP.", [option, "Cygnetics2"]), "ERP");
  const closed = determineMarketEligibility(option, category, "Australia", [{
    url, document: {
      ...document, text: "Axiomora ERP is not licensed in Australia.",
      sha256: "f".repeat(64),
    },
  }], checkedAt);
  assert.equal(closed.status, "INELIGIBLE");
  assert.equal(priorSoftwareIdentity(option), undefined, "closure removes stale commercial proof");
  assert.equal(determineMarketEligibility(option, category, "Australia", [],
    checkedAt).status, "UNKNOWN", "without current proof the opaque identity is not scoreable");
});

test("ambiguous names retain category-scoped proofs without overriding a bank identity", () => {
  const option = "Omnivara";
  for (const [category, description] of [
    ["ERP", "enterprise resource planning"],
    ["Analytics Platform", "analytics platform"],
  ] as const) {
    const proof = softwareIdentityFromDocument(option, category, {
      finalUrl: "https://omnivara.com/products",
      text: `Omnivara is a ${description} for businesses. Request a demo.`,
      sha256: "c".repeat(64), retrievedAt: checkedAt,
    }, checkedAt);
    assert.ok(proof);
    rememberSoftwareIdentity(proof!);
  }
  assert.equal(priorSoftwareIdentity(option), undefined, "a name alone cannot pick between two domains");
  assert.equal(classifyComparisonOption(option).type, "unknown");
  assert.equal(determineMarketEligibility(option, "ERP", "India", [], checkedAt).status, "ELIGIBLE");
  assert.equal(determineMarketEligibility(option, "Analytics Platform", "India", [], checkedAt).status, "ELIGIBLE");
  assert.equal(determineMarketEligibility(option, "Cloud Platform", "India", [], checkedAt).status, "UNKNOWN");

  const bankProof = softwareIdentityFromDocument("Westpac", "ERP", {
    finalUrl: "https://westpac.com/erp",
    text: "Westpac is an ERP platform. Request a demo.",
    sha256: "d".repeat(64), retrievedAt: checkedAt,
  }, checkedAt);
  assert.ok(bankProof);
  rememberSoftwareIdentity(bankProof!);
  assert.equal(classifyComparisonOption("Westpac").type, "bank");
  assert.equal(determineMarketEligibility("Westpac", "ERP", "India", [], checkedAt).status, "UNKNOWN");
  forgetSoftwareIdentity("Westpac", bankProof!.domain);
});