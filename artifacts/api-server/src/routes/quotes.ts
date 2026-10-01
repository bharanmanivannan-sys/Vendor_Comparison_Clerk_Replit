import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import multer from "multer";
import { z } from "zod/v4";
import { GetComparisonQuotesResponse } from "@workspace/api-zod";
import { comparisonQuotesTable, comparisonsTable, db, quoteObjectDeletionsTable, type ComparisonQuote } from "@workspace/db";
import { assessBuyerQuotes, quotedTotalAud } from "../lib/quotePricing";
import { deleteQuotePdf, deleteQueuedQuotePdf, enqueueQuotePdfDeletion, newQuotePdfKey, saveQuotePdfAtKey, streamQuotePdf } from "../lib/quoteObjects";

const router: IRouter = Router();
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 1, fieldSize: 8_192, fileSize: 8 * 1024 * 1024 },
}).single("file");

const decimal = z.string().regex(/^\d{1,9}(?:\.\d{1,2})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const detailsSchema = z.object({
  vendor: z.string().min(1).max(150),
  documentDate: date,
  validUntil: date,
  currency: z.enum(["AUD", "USD", "EUR", "GBP"]),
  termMonths: z.coerce.number().int().min(1).max(60),
  licenseAnnual: decimal,
  implementationOnce: decimal,
  serviceAnnual: decimal,
  audPerUnit: z.string().regex(/^\d{1,4}(?:\.\d{1,6})?$/),
  exchangeRateDate: date.optional(),
  exchangeRateSource: z.string().url().startsWith("https://").max(400).optional(),
  scope: z.string().trim().min(5).max(500),
  taxBasis: z.enum(["ex_gst", "inc_gst"]),
  exclusions: z.string().trim().min(1).max(500),
});

function error(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: message, code, message });
}
function owner(req: Request, res: Response): string | null {
  const userId = getAuth(req).userId;
  if (!userId) error(res, 401, "unauthorized", "Unauthorized");
  return userId;
}
async function ownedComparison(rawId: string, userId: string) {
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) return null;
  const [row] = await db.select({ id: comparisonsTable.id, vendors: comparisonsTable.vendors })
    .from(comparisonsTable).where(and(eq(comparisonsTable.id, Number(rawId)), eq(comparisonsTable.userId, userId)));
  return row ?? null;
}
function calendarTime(day: string): number | null {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : null;
}
function validateCurrent(details: z.infer<typeof detailsSchema>): string | null {
  const now = calendarTime(new Date().toISOString().slice(0, 10))!;
  const issued = calendarTime(details.documentDate);
  const until = calendarTime(details.validUntil);
  if (issued === null || issued > now || now - issued > 366 * 86_400_000 || until === null || until < now || until < issued) {
    return "Upload a dated quote issued within the past year that has not expired.";
  }
  const fxDate = details.exchangeRateDate ? calendarTime(details.exchangeRateDate) : null;
  const fx = Number(details.audPerUnit);
  if (fx <= 0 || fx > 1000 || !Number.isFinite(fx)
    || (details.currency === "AUD" && fx !== 1)
    || (details.currency !== "AUD" && (!fxDate || fxDate > now || now - fxDate > 366 * 86_400_000
      || !details.exchangeRateSource))) {
    return "Use AUD at 1:1, or supply a current dated HTTPS source and AUD-per-unit rate for foreign currency.";
  }
  return null;
}
async function bundle(comparison: { id: number; vendors: string[] }, userId: string) {
  const rows = await db.select().from(comparisonQuotesTable)
    .where(and(eq(comparisonQuotesTable.comparisonId, comparison.id), eq(comparisonQuotesTable.userId, userId)));
  const assessment = assessBuyerQuotes(comparison.vendors, rows);
  return GetComparisonQuotesResponse.parse({
    quotes: rows.map((row) => {
      return {
        vendor: row.vendor,
        documentDate: row.documentDate,
        validUntil: row.validUntil,
        currency: row.currency,
        termMonths: row.termMonths,
        licenseAnnual: row.licenseAnnual,
        implementationOnce: row.implementationOnce,
        serviceAnnual: row.serviceAnnual,
        audPerUnit: row.audPerUnit,
        ...(row.exchangeRateDate ? { exchangeRateDate: row.exchangeRateDate } : {}),
        ...(row.exchangeRateSource ? { exchangeRateSource: row.exchangeRateSource } : {}),
        scope: row.scope,
        taxBasis: row.taxBasis,
        exclusions: row.exclusions,
        fileName: row.fileName,
        fileSha256: row.fileSha256,
        documentUrl: `/api/comparisons/${comparison.id}/quotes/${encodeURIComponent(row.vendor)}/document`,
        totalAud: quotedTotalAud(row),
      };
    }),
    assessment,
  });
}
async function ownedQuote(comparisonId: number, vendor: string, userId: string): Promise<ComparisonQuote | null> {
  const [row] = await db.select().from(comparisonQuotesTable)
    .where(and(eq(comparisonQuotesTable.comparisonId, comparisonId), eq(comparisonQuotesTable.vendor, vendor),
      eq(comparisonQuotesTable.userId, userId)));
  return row ?? null;
}

router.get("/comparisons/:id/quotes", async (req, res) => {
  const userId = owner(req, res);
  if (!userId) return;
  const comparison = await ownedComparison(String(req.params.id), userId);
  if (!comparison) return error(res, 404, "not_found", "Comparison not found");
  res.json(await bundle(comparison, userId));
});

router.post("/comparisons/:id/quotes", (req, res, next) => {
  const userId = owner(req, res);
  if (!userId) return;
  pdfUpload(req, res, (uploadError) => {
    if (uploadError) return error(res, 400, "invalid_quote_file", "Provide one PDF under 8 MB and quote details.");
    next();
  });
}, async (req, res) => {
  const userId = getAuth(req).userId!;
  const comparison = await ownedComparison(String(req.params.id), userId);
  if (!comparison) return error(res, 404, "not_found", "Comparison not found");
  let raw: unknown;
  try { raw = JSON.parse(String(req.body?.details ?? "")); } catch {
    return error(res, 400, "invalid_quote", "Enter the quoted commercial terms.");
  }
  const parsed = detailsSchema.safeParse(raw);
  if (!parsed.success || !comparison.vendors.includes(parsed.data.vendor)) {
    return error(res, 400, "invalid_quote", "Choose an exact compared option and complete all commercial terms.");
  }
  const invalid = validateCurrent(parsed.data);
  if (invalid) return error(res, 400, "invalid_quote", invalid);
  const file = req.file;
  if (!file || file.mimetype !== "application/pdf" || !file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))
    || !file.buffer.subarray(-1024).includes(Buffer.from("%%EOF"))) {
    return error(res, 400, "invalid_quote_file", "Upload a valid PDF quote under 8 MB.");
  }
  const fileName = file.originalname.replace(/[\r\n\\/\"\x00-\x1f]/g, "_").slice(0, 140) || "vendor-quote.pdf";
  let objectKey: string | null = null;
  try {
    // Reserve the key before touching storage. A crash after upload therefore
    // leaves a durable outbox entry rather than an untracked private object.
    objectKey = newQuotePdfKey(comparison.id);
    // The retry worker must not delete an in-flight upload before its row is
    // adopted by the transaction. A crashed upload is collected after this
    // reservation window; normal failures clean it up immediately below.
    await enqueueQuotePdfDeletion(objectKey, 10 * 60_000);
    await saveQuotePdfAtKey(objectKey, file.buffer);
    const uploadedObjectKey = objectKey;
    const details = parsed.data;
    await db.transaction(async (tx) => {
      const [parent] = await tx.select({ id: comparisonsTable.id }).from(comparisonsTable)
        .where(and(eq(comparisonsTable.id, comparison.id), eq(comparisonsTable.userId, userId)))
        .for("update");
      if (!parent) throw new Error("Comparison no longer exists");
      const [current] = await tx.select({ id: comparisonQuotesTable.id, objectKey: comparisonQuotesTable.objectKey })
        .from(comparisonQuotesTable).where(and(eq(comparisonQuotesTable.comparisonId, comparison.id),
          eq(comparisonQuotesTable.vendor, details.vendor), eq(comparisonQuotesTable.userId, userId)));
      if (current) {
        await tx.insert(quoteObjectDeletionsTable).values({ objectKey: current.objectKey })
          .onConflictDoNothing({ target: quoteObjectDeletionsTable.objectKey });
      }
      await tx.insert(comparisonQuotesTable).values({
      comparisonId: comparison.id, userId, vendor: details.vendor,
      documentDate: details.documentDate, validUntil: details.validUntil,
      currency: details.currency, termMonths: details.termMonths,
      licenseAnnual: details.licenseAnnual, implementationOnce: details.implementationOnce,
      serviceAnnual: details.serviceAnnual, audPerUnit: details.audPerUnit,
      exchangeRateDate: details.currency === "AUD" ? null : details.exchangeRateDate,
      exchangeRateSource: details.currency === "AUD" ? null : details.exchangeRateSource,
      scope: details.scope, taxBasis: details.taxBasis, exclusions: details.exclusions,
      fileName, fileSha256: createHash("sha256").update(file.buffer).digest("hex"), objectKey: uploadedObjectKey,
      }).onConflictDoUpdate({
      target: [comparisonQuotesTable.comparisonId, comparisonQuotesTable.vendor],
      set: {
        documentDate: details.documentDate, validUntil: details.validUntil, currency: details.currency,
        termMonths: details.termMonths, licenseAnnual: details.licenseAnnual, implementationOnce: details.implementationOnce,
        serviceAnnual: details.serviceAnnual, audPerUnit: details.audPerUnit,
        exchangeRateDate: details.currency === "AUD" ? null : details.exchangeRateDate,
        exchangeRateSource: details.currency === "AUD" ? null : details.exchangeRateSource,
        scope: details.scope, taxBasis: details.taxBasis, exclusions: details.exclusions,
        fileName, fileSha256: createHash("sha256").update(file.buffer).digest("hex"), objectKey: uploadedObjectKey,
      },
      });
      await tx.delete(quoteObjectDeletionsTable)
        .where(eq(quoteObjectDeletionsTable.objectKey, uploadedObjectKey));
    });
  } catch (cause) {
    if (objectKey) {
      // Persist the key before cleanup so a storage outage cannot orphan it.
      try {
        await deleteQueuedQuotePdf(objectKey);
      } catch (cleanupError) {
        req.log.error({ message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
          "New quote cleanup queued for retry");
        // If the database itself was unavailable, make a best-effort direct
        // delete as well; there is no row in which to retain this key.
        await deleteQuotePdf(objectKey).catch((directError) => {
          req.log.error({ message: directError instanceof Error ? directError.message : String(directError) },
            "New quote direct cleanup failed; key was not persisted");
        });
      }
    }
    req.log.error({ message: cause instanceof Error ? cause.message : String(cause) }, "Private quote upload failed");
    return error(res, 503, "quote_storage_unavailable", "Could not save the quote. Try again.");
  }
  res.json(await bundle(comparison, userId));
});

router.delete("/comparisons/:id/quotes/:vendor", async (req, res) => {
  const userId = owner(req, res);
  if (!userId) return;
  const comparison = await ownedComparison(String(req.params.id), userId);
  if (!comparison) return error(res, 404, "not_found", "Comparison not found");
  const vendor = String(req.params.vendor);
  if (!comparison.vendors.includes(vendor)) return error(res, 404, "not_found", "Quote not found");
  const [removed] = await db.transaction(async (tx) => {
    await tx.select({ id: comparisonsTable.id }).from(comparisonsTable)
      .where(and(eq(comparisonsTable.id, comparison.id), eq(comparisonsTable.userId, userId))).for("update");
    const [row] = await tx.select({ id: comparisonQuotesTable.id, objectKey: comparisonQuotesTable.objectKey })
      .from(comparisonQuotesTable)
      .where(and(eq(comparisonQuotesTable.comparisonId, comparison.id),
        eq(comparisonQuotesTable.vendor, vendor), eq(comparisonQuotesTable.userId, userId)));
    if (!row) return [];
    await tx.insert(quoteObjectDeletionsTable).values({ objectKey: row.objectKey })
      .onConflictDoNothing({ target: quoteObjectDeletionsTable.objectKey });
    return tx.delete(comparisonQuotesTable).where(eq(comparisonQuotesTable.id, row.id))
      .returning({ objectKey: comparisonQuotesTable.objectKey });
  });
  if (!removed) return error(res, 404, "not_found", "Quote not found");
  try {
    await deleteQueuedQuotePdf(removed.objectKey);
  } catch (cause) {
    req.log.error({ message: cause instanceof Error ? cause.message : String(cause) }, "Quote cleanup queued for retry");
    return error(res, 503, "quote_storage_unavailable", "Quote removed from the comparison, but its private file is still being deleted. Try again.");
  }
  res.json(await bundle(comparison, userId));
});

router.get("/comparisons/:id/quotes/:vendor/document", async (req, res) => {
  const userId = owner(req, res);
  if (!userId) return;
  const comparison = await ownedComparison(String(req.params.id), userId);
  if (!comparison) return error(res, 404, "not_found", "Comparison not found");
  const vendor = String(req.params.vendor);
  if (!comparison.vendors.includes(vendor)) return error(res, 404, "not_found", "Quote not found");
  const quote = await ownedQuote(comparison.id, vendor, userId);
  if (!quote) return error(res, 404, "not_found", "Quote not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${quote.fileName}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  const stream = streamQuotePdf(quote.objectKey);
  stream.on("error", (cause) => {
    req.log.error({ message: cause instanceof Error ? cause.message : String(cause) }, "Quote download failed");
    if (!res.headersSent) error(res, 503, "quote_storage_unavailable", "The quote file is unavailable.");
    else res.destroy(cause);
  });
  stream.pipe(res);
});

export default router;