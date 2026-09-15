import { and, eq, inArray } from "drizzle-orm";
import { db, tenantMembershipsTable, tenantsTable } from "@workspace/db";

export async function ensurePersonalTenant(userId: string) {
  const tenantId = `personal_${userId}`;
  await db.transaction(async (tx) => {
    await tx.insert(tenantsTable).values({
      id: tenantId,
      name: "Personal workspace",
      plan: "free",
      billingStatus: "inactive",
    }).onConflictDoNothing();
    await tx.insert(tenantMembershipsTable).values({
      tenantId,
      userId,
      role: "owner",
    }).onConflictDoNothing();
  });
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  return tenant;
}

export async function getAdminTenant(userId: string, tenantId: string) {
  const rows = await db.select({ tenant: tenantsTable, role: tenantMembershipsTable.role })
    .from(tenantMembershipsTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, tenantMembershipsTable.tenantId))
    .where(and(
      eq(tenantMembershipsTable.userId, userId),
      eq(tenantMembershipsTable.tenantId, tenantId),
      inArray(tenantMembershipsTable.role, ["owner", "admin"]),
    ));
  return rows[0] ?? null;
}