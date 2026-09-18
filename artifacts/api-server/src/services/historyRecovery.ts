import { clerkClient } from "@clerk/express";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import {
  comparisonsTable,
  db,
  tenantMembershipsTable,
  tenantsTable,
} from "@workspace/db";

type ClerkIdentity = Awaited<ReturnType<typeof clerkClient.users.getUser>>;

export function verifiedEmailKeys(user: ClerkIdentity): Set<string> {
  const keys = new Set<string>();
  for (const email of user.emailAddresses) {
    if (email.verification?.status === "verified") {
      keys.add(`email:${email.emailAddress.trim().toLowerCase()}`);
    }
  }
  return keys;
}

export function verifiedEmailsMatch(current: ClerkIdentity, legacy: ClerkIdentity): boolean {
  const currentKeys = verifiedEmailKeys(current);
  return [...verifiedEmailKeys(legacy)].some((key) => currentKeys.has(key));
}

export async function recoverVerifiedHistory(currentUserId: string) {
  let currentUser: ClerkIdentity;
  try {
    currentUser = await clerkClient.users.getUser(currentUserId);
  } catch {
    throw new Error("current_identity_unavailable");
  }

  const verifiedEmails = currentUser.emailAddresses
    .filter((email) => email.verification?.status === "verified")
    .map((email) => email.emailAddress.trim().toLowerCase());
  if (!verifiedEmails.length) {
    throw new Error("current_identity_unavailable");
  }
  let matchingUsers: ClerkIdentity[];
  try {
    const result = await clerkClient.users.getUserList({
      emailAddress: verifiedEmails,
      limit: 100,
    });
    if (result.totalCount > result.data.length) {
      throw new Error("identity_lookup_incomplete");
    }
    matchingUsers = result.data;
  } catch {
    throw new Error("current_identity_unavailable");
  }
  const matchedLegacyIds = matchingUsers
    .filter((user) => user.id !== currentUserId && verifiedEmailsMatch(currentUser, user))
    .map((user) => user.id);

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const tenantId = `personal_${currentUserId}`;
  const recoveredComparisons = await db.transaction(async (tx) => {
    await tx.insert(tenantsTable).values({
      id: tenantId,
      name: "Personal workspace",
      plan: "free",
      billingStatus: "inactive",
    }).onConflictDoNothing();
    await tx.insert(tenantMembershipsTable).values({
      tenantId,
      userId: currentUserId,
      role: "owner",
    }).onConflictDoNothing();
    await tx.update(comparisonsTable)
      .set({ tenantId })
      .where(and(
        eq(comparisonsTable.userId, currentUserId),
        isNull(comparisonsTable.tenantId),
      ));
    if (!matchedLegacyIds.length) return 0;
    const recovered = await tx.update(comparisonsTable)
      .set({ userId: currentUserId, tenantId })
      .where(and(
        inArray(comparisonsTable.userId, matchedLegacyIds),
        gte(comparisonsTable.createdAt, since),
        or(isNull(comparisonsTable.tenantId), eq(comparisonsTable.tenantId, tenantId)),
      ))
      .returning({ id: comparisonsTable.id });
    return recovered.length;
  });

  return {
    recoveredComparisons,
    matchedLegacyAccounts: matchedLegacyIds.length,
    unavailableLegacyAccounts: 0,
  };
}