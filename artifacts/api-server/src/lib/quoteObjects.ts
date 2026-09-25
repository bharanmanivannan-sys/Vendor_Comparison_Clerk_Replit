import { Storage } from "@google-cloud/storage";
import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { db, quoteObjectDeletionsTable } from "@workspace/db";

const endpoint = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${endpoint}/token`,
    type: "external_account",
    credential_source: {
      url: `${endpoint}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function privateDirectory() {
  const value = process.env.PRIVATE_OBJECT_DIR;
  if (!value || !/^\/[^/]+\/.+/.test(value)) throw new Error("Private object storage is not configured");
  return value.replace(/\/$/, "");
}

function fileForKey(key: string) {
  const prefix = `${privateDirectory()}/buyer-quotes/`;
  if (!key.startsWith(prefix) || !/^\/[^/]+\/.+/.test(key)) throw new Error("Invalid private object key");
  const [, bucket, ...parts] = key.split("/");
  return storage.bucket(bucket!).file(parts.join("/"));
}

export function newQuotePdfKey(comparisonId: number): string {
  return `${privateDirectory()}/buyer-quotes/${comparisonId}/${randomUUID()}.pdf`;
}

export async function saveQuotePdfAtKey(key: string, bytes: Buffer): Promise<string> {
  await fileForKey(key).save(bytes, {
    resumable: false,
    contentType: "application/pdf",
    metadata: { cacheControl: "private, no-store" },
  });
  return key;
}

export async function saveQuotePdf(comparisonId: number, bytes: Buffer): Promise<string> {
  return saveQuotePdfAtKey(newQuotePdfKey(comparisonId), bytes);
}

export async function deleteQuotePdf(key: string): Promise<void> {
  await fileForKey(key).delete({ ignoreNotFound: true });
}

/** Add a key before attempting deletion. This is the durable hand-off point. */
export async function enqueueQuotePdfDeletion(key: string, delayMs = 0): Promise<void> {
  await db.insert(quoteObjectDeletionsTable).values({
    objectKey: key,
    nextAttemptAt: new Date(Date.now() + delayMs),
  })
    .onConflictDoNothing({ target: quoteObjectDeletionsTable.objectKey });
}

export async function deleteQueuedQuotePdf(
  key: string,
  removeObject: (key: string) => Promise<void> = deleteQuotePdf,
  acknowledge: (key: string) => Promise<void> = async (objectKey) => {
    await db.delete(quoteObjectDeletionsTable)
      .where(eq(quoteObjectDeletionsTable.objectKey, objectKey));
  },
): Promise<void> {
  await removeObject(key);
  await acknowledge(key);
}

/** Retry outbox entries. Failures stay queued and are deliberately logged by callers. */
export async function retryQuotePdfDeletions(log: (message: string, error: unknown) => void): Promise<void> {
  const rows = await db.select().from(quoteObjectDeletionsTable)
    .where(lte(quoteObjectDeletionsTable.nextAttemptAt, new Date())).limit(50);
  await Promise.all(rows.map(async (row) => {
    try {
      await deleteQueuedQuotePdf(row.objectKey);
    } catch (error) {
      log(`Private quote deletion retry failed for ${row.objectKey}`, error);
      await db.update(quoteObjectDeletionsTable).set({
        attempts: row.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
        nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(row.attempts, 8))),
      }).where(and(eq(quoteObjectDeletionsTable.id, row.id), eq(quoteObjectDeletionsTable.objectKey, row.objectKey)));
    }
  }));
}

/** Schema gate for startup: never start deletion work against a pre-migration DB. */
export async function quoteDeletionOutboxReady(): Promise<boolean> {
  try {
    await db.select({ id: quoteObjectDeletionsTable.id }).from(quoteObjectDeletionsTable).limit(1);
    return true;
  } catch {
    return false;
  }
}

export function streamQuotePdf(key: string) {
  return fileForKey(key).createReadStream();
}