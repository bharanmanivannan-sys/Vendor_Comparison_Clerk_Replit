import { canonicalEntityId } from "./entityIdentity";

export type SoftwareDomain =
  | "Customer Engagement Platforms" | "Digital Experience Platforms"
  | "Content Management Systems" | "Enterprise Resource Planning"
  | "Project Management Platforms" | "Collaboration Platforms"
  | "Analytics Platforms" | "Data Platforms" | "Identity Platforms"
  | "Cloud Platforms" | "Software Platforms";

type Category = { domain: SoftwareDomain; names: string[]; pattern: RegExp };
const CATEGORIES: Category[] = [
  { domain: "Customer Engagement Platforms", names: ["CRM / Marketing Platform", "Customer Engagement Platform", "Customer Engagement Platforms", "CRM software", "CRM Platform", "Marketing Platform", "Marketing Cloud", "CX Platform"], pattern: /\b(?:crm|customer relationship management|customer engagement|customer experience platforms?|cx platforms?|marketing platforms?|marketing clouds?|marketing automation|sales cloud|service cloud)\b/i },
  { domain: "Digital Experience Platforms", names: ["Digital Experience Platform", "Digital Experience Platforms", "DXP"], pattern: /\b(?:digital experience platforms?|dxp|headless cms)\b/i },
  { domain: "Content Management Systems", names: ["CMS", "Content Management System"], pattern: /\b(?:content management systems?|cms)\b/i },
  { domain: "Enterprise Resource Planning", names: ["ERP", "Enterprise Resource Planning"], pattern: /\b(?:enterprise resource planning|erp)\b/i },
  { domain: "Project Management Platforms", names: ["Project Management Platform", "Project management software"], pattern: /\b(?:project management platforms?|project management software|project management tools?)\b/i },
  { domain: "Collaboration Platforms", names: ["Collaboration Platform"], pattern: /\b(?:collaboration platforms?|collaboration software)\b/i },
  { domain: "Analytics Platforms", names: ["Analytics Platform"], pattern: /\b(?:analytics platforms?|business intelligence platforms?)\b/i },
  { domain: "Data Platforms", names: ["Data Platform"], pattern: /\b(?:data platforms?|data warehouse platforms?)\b/i },
  { domain: "Identity Platforms", names: ["Identity Platform"], pattern: /\b(?:identity platforms?|identity management platforms?)\b/i },
  { domain: "Cloud Platforms", names: ["Cloud Platform"], pattern: /\b(?:cloud platforms?|cloud computing platforms?)\b/i },
  { domain: "Software Platforms", names: ["Software Platform"], pattern: /\b(?:software platforms?|software systems?)\b/i },
];

export function softwareDomainForCategory(category: string): SoftwareDomain | undefined {
  return CATEGORIES.find(({ names }) => names.some((name) => name.toLowerCase() === category.toLowerCase()))?.domain;
}

export type SoftwareIdentityProof = {
  name: string;
  domain: SoftwareDomain;
  category: string;
  sourceUrl: string;
  documentSha256: string;
  retrievedAt: string;
  commercialClaim: string;
};

type Document = { finalUrl: string; text: string; sha256: string; retrievedAt: string };
const PROOF_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROOFS = 500;
const proofs = new Map<string, SoftwareIdentityProof>();
const identityKey = (name: string, domain: SoftwareDomain) => `${canonicalEntityId(name).toLowerCase()}|${domain}`;
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const COMMERCIAL_OFFER = /\b(?:request (?:a )?demo|contact sales|start (?:a |your )?(?:free )?trial|buy now|subscribe now|purchase now|pricing|plans? and pricing|sign up|available now)\b/i;
const CLOSED = /\b(?:discontinued|sunset|withdrawn|no longer available|not available in|unavailable in|not licensed in|closed to new|not accepting new)\b/i;

/** A document must identify the exact product and its category and present a commercial offer. */
export function softwareIdentityFromDocument(
  option: string, category: string, document: Document, now = new Date().toISOString(),
): SoftwareIdentityProof | undefined {
  const domain = softwareDomainForCategory(category);
  if (!domain || !/^[a-f0-9]{64}$/i.test(document.sha256)) return;
  const retrievedAt = Date.parse(document.retrievedAt);
  const currentTime = Date.parse(now);
  if (!Number.isFinite(retrievedAt) || !Number.isFinite(currentTime)
    || retrievedAt > currentTime + 5 * 60_000 || currentTime - retrievedAt > PROOF_LIFETIME_MS) return;
  const name = canonicalEntityId(option).trim();
  if (name.length < 3 || /^(?:software|platform|crm|cms|erp|marketing cloud|cloud platform)$/i.test(name)) return;
  let host: string;
  try { host = new URL(document.finalUrl).hostname.toLowerCase(); } catch { return; }
  if (!/^https:\/\//i.test(document.finalUrl)) return;
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3
    && !["cloud", "platform", "software", "system", "marketing", "management", "digital", "enterprise"].includes(token));
  if (!tokens.some((token) => host.split(".").some((label) => label === token))) return;
  const exactName = new RegExp(`(?:^|[^a-z0-9])${name.replace(ESCAPE, "\\$&").replace(/\s+/g, "\\s+")}(?=$|[^a-z0-9])`, "i");
  const categoryPattern = CATEGORIES.find((entry) => entry.domain === domain)!.pattern;
  // A conflicting closure anywhere on the same product page is not reusable
  // active proof, even if its positive CTA appears in an earlier paragraph.
  if (CLOSED.test(document.text)) return;
  const segments = document.text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const claim = segments[index]!;
    if (!exactName.test(claim) || !categoryPattern.test(claim)) continue;
    const context = [claim, ...segments.slice(index + 1, index + 3)].join(" ").slice(0, 600);
    if (CLOSED.test(context) || !COMMERCIAL_OFFER.test(context)) continue;
    return {
      name, domain, category, sourceUrl: document.finalUrl,
      documentSha256: document.sha256.toLowerCase(), retrievedAt: document.retrievedAt,
      commercialClaim: context.slice(0, 300),
    };
  }
  return;
}

/** Only permission-checked public discovery results may enter the shared cache. */
export function rememberSoftwareIdentity(proof: SoftwareIdentityProof): void {
  const key = identityKey(proof.name, proof.domain);
  proofs.delete(key);
  proofs.set(key, proof);
  while (proofs.size > MAX_PROOFS) proofs.delete(proofs.keys().next().value!);
}

export function forgetSoftwareIdentity(name: string, domain: SoftwareDomain): void {
  proofs.delete(identityKey(name, domain));
}

export function priorSoftwareIdentity(name: string, domain?: SoftwareDomain, now = new Date().toISOString()): SoftwareIdentityProof | undefined {
  const currentTime = Date.parse(now);
  if (!Number.isFinite(currentTime)) return;
  const matches: SoftwareIdentityProof[] = [];
  for (const [key, proof] of proofs) {
    if (canonicalEntityId(name).toLowerCase() !== canonicalEntityId(proof.name).toLowerCase()
      || (domain && proof.domain !== domain)) continue;
    if (currentTime - Date.parse(proof.retrievedAt) <= PROOF_LIFETIME_MS) {
      matches.push(proof);
    } else {
      proofs.delete(key);
    }
  }
  // Without a category, multiple supported domains cannot safely determine
  // what an opaque product name means in the user's comparison.
  return domain || matches.length === 1 ? matches[0] : undefined;
}