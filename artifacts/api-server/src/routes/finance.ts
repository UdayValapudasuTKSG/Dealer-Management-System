import { getDealerPdfBranding } from "../lib/dealer-branding";
import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import {
  db,
  financeApplicationsTable,
  financeDocumentsTable,
  banksTable,
  losSubmissionsTable,
  invoicesTable,
  paymentsTable,
  receiptsTable,
  gatesTable,
  bookingsTable,
  dealsTable,
  customersTable,
  vehiclesTable,
  insertFinanceDocumentSchema,
  type FinanceApplication,
} from "@workspace/db";
import { logCancellationEvent } from "../lib/cancellation";
import {
  CreateFinanceApplicationBody,
  UpdateFinanceApplicationBody,
  UpdateFinanceApplicationParams,
  ListFinanceApplicationsResponse,
  ListFinanceApplicationsQueryParams,
  CreateFinanceApplicationResponse,
  UpdateFinanceApplicationResponse,
  GetFinanceApplicationParams,
  GetFinanceApplicationResponse,
  SubmitFinanceApplicationParams,
  SyncFinanceApplicationParams,
  ListFinanceDocumentsParams,
  ListFinanceDocumentsResponse,
  UploadFinanceDocumentParams,
  UploadFinanceDocumentResponse,
  DeleteFinanceDocumentParams,
  DownloadFinanceDocumentParams,
  GetFinanceConnectorStatusResponse,
  ListBanksResponse,
  CreateBankBody,
  CreateBankResponse,
  UpdateBankBody,
  UpdateBankParams,
  UpdateBankResponse,
  ListInvoicesResponse,
  ListInvoicesQueryParams,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  UpdateInvoiceBody,
  UpdateInvoiceParams,
  UpdateInvoiceResponse,
  ListPaymentsResponse,
  CreatePaymentBody,
  CreatePaymentResponse,
  ListReceiptsResponse,
  GetReceiptParams,
  GetReceiptResponse,
  ListOutstandingBalancesResponse,
} from "@workspace/api-zod";
import {
  applyPayment,
  PaymentGuardError,
  invoicePaidTotal,
  issueInvoice,
  logPaymentEvent,
} from "../lib/invoicing";
import { queueInvoiceSync } from "../lib/erpnext/entities";
import { buildReceiptPdf } from "../lib/document-pdfs";
import { storage } from "../lib/storage";
import { getLosConnector } from "../lib/los";
import { activeDealerId } from "../middlewares/rbac";
import { notifyRefundPaid } from "../lib/notify-triggers";
import { idempotent } from "../middlewares/idempotency";
import {
  transitionFinanceStatus,
  statusEvent,
} from "../lib/finance-effects";
import {
  DealCommitConflictError,
  InventoryAllocationError,
} from "../lib/deal-commit";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

router.get("/finance-applications", async (req, res): Promise<void> => {
  const query = ListFinanceApplicationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(financeApplicationsTable)
    .where(
      and(
        eq(financeApplicationsTable.dealerId, activeDealerId(res)),
        ...(query.data.status
          ? [eq(financeApplicationsTable.status, query.data.status)]
          : []),
      ),
    )
    .orderBy(desc(financeApplicationsTable.createdAt));
  res.json(ListFinanceApplicationsResponse.parse(rows));
});

router.post("/finance-applications", async (req, res): Promise<void> => {
  const parsed = CreateFinanceApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // A5 financing sanity gates: the facility must exceed the down payment and
  // the term must be a realistic 12–84 months.
  const downPayment = parsed.data.downPayment ?? 0;
  if (parsed.data.amount <= downPayment) {
    res.status(422).json({
      error: "Financed amount must be greater than the down payment",
    });
    return;
  }
  if (parsed.data.termMonths < 12 || parsed.data.termMonths > 84) {
    res.status(422).json({
      error: "Term must be between 12 and 84 months",
    });
    return;
  }

  const [application] = await db
    .insert(financeApplicationsTable)
    .values({
      ...parsed.data,
      dealerId: activeDealerId(res),
      status: "pending",
      statusHistory: [
        statusEvent(
          "pending",
          "Application drafted — capture employment, income and documents, then submit to the lender.",
        ),
      ],
    })
    .returning();

  res.status(201).json(CreateFinanceApplicationResponse.parse(application));
});

router.get("/finance-applications/:id", async (req, res): Promise<void> => {
  const params = GetFinanceApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [application] = await db
    .select()
    .from(financeApplicationsTable)
    .where(
      and(
        eq(financeApplicationsTable.id, params.data.id),
        eq(financeApplicationsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!application) {
    res.status(404).json({ error: "Finance application not found" });
    return;
  }
  const [documents, submissions] = await Promise.all([
    db
      .select()
      .from(financeDocumentsTable)
      .where(eq(financeDocumentsTable.applicationId, application.id))
      .orderBy(desc(financeDocumentsTable.createdAt)),
    db
      .select()
      .from(losSubmissionsTable)
      .where(eq(losSubmissionsTable.applicationId, application.id))
      .orderBy(desc(losSubmissionsTable.createdAt)),
  ]);
  res.json(
    GetFinanceApplicationResponse.parse({
      application,
      documents,
      submissions,
    }),
  );
});

router.patch("/finance-applications/:id", async (req, res): Promise<void> => {
  const params = UpdateFinanceApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateFinanceApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [before] = await db
    .select()
    .from(financeApplicationsTable)
    .where(
      and(
        eq(financeApplicationsTable.id, params.data.id),
        eq(financeApplicationsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!before) {
    res.status(404).json({ error: "Finance application not found" });
    return;
  }

  const { status, ...rest } = parsed.data;
  const statusChanged = status !== undefined && status !== before.status;
  const note = statusChanged
    ? `Status set manually by the finance desk.`
    : "";

  let application: typeof financeApplicationsTable.$inferSelect | null =
    null;
  try {
    if (statusChanged) {
      // In particular, disbursement must share the finance/deal/allocation
      // transaction. A failed quantity allocation leaves every row untouched.
      application = await transitionFinanceStatus(
        params.data.id,
        status!,
        note,
        rest,
      );
    } else {
      [application] = await db
        .update(financeApplicationsTable)
        .set(rest)
        .where(
          and(
            eq(financeApplicationsTable.id, params.data.id),
            eq(financeApplicationsTable.dealerId, activeDealerId(res)),
          ),
        )
        .returning();
    }
  } catch (err) {
    if (
      err instanceof InventoryAllocationError ||
      err instanceof DealCommitConflictError
    ) {
      res.status(409).json({
        error:
          err instanceof InventoryAllocationError
            ? "insufficient_inventory"
            : "deal_commit_conflict",
        detail: err.message,
        ...(err instanceof InventoryAllocationError
          ? {
              dealItemId: err.itemId || null,
              requested: err.requested,
              allocated: err.allocated,
            }
          : {}),
      });
      return;
    }
    throw err;
  }

  if (!application) {
    res.status(404).json({ error: "Finance application not found" });
    return;
  }
  res.json(UpdateFinanceApplicationResponse.parse(application));
});

// ---------------------------------------------------------------------------
// LOS connector — submit & sync
// ---------------------------------------------------------------------------

router.get("/finance-connector", async (_req, res): Promise<void> => {
  const connector = getLosConnector();
  res.json(
    GetFinanceConnectorStatusResponse.parse({
      connector: connector.name,
      mode: connector.mode,
      configured: connector.mode === "live",
    }),
  );
});

async function recordSubmission(
  app: FinanceApplication,
  event: "submit" | "sync",
  status: string,
  message: string,
  reference: string | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  const connector = getLosConnector();
  await db.insert(losSubmissionsTable).values({
    dealerId: app.dealerId,
    applicationId: app.id,
    connector: connector.name,
    mode: connector.mode,
    event,
    status,
    reference,
    message,
    payload: payload ?? null,
  });
}

router.post(
  "/finance-applications/:id/submit",
  async (req, res): Promise<void> => {
    const params = SubmitFinanceApplicationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [app] = await db
      .select()
      .from(financeApplicationsTable)
      .where(
        and(
          eq(financeApplicationsTable.id, params.data.id),
          eq(financeApplicationsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!app) {
      res.status(404).json({ error: "Finance application not found" });
      return;
    }
    if (app.status !== "pending") {
      res.status(400).json({
        error: `Application is already ${app.status.replace("_", " ")} — only pending applications can be submitted.`,
      });
      return;
    }

    const connector = getLosConnector();
    try {
      const result = await connector.submit(app);
      await recordSubmission(
        app,
        "submit",
        result.status,
        result.message,
        result.reference,
        result.raw,
      );
      const updated = await transitionFinanceStatus(
        app.id,
        result.status,
        result.message,
        {
          losConnector: connector.name,
          losReference: result.reference,
          submittedAt: new Date(),
          lender: app.lender ?? "Demerara Bank",
        },
      );
      res.json(UpdateFinanceApplicationResponse.parse(updated));
    } catch (err) {
      req.log.error({ err, appId: app.id }, "LOS submission failed");
      if (
        err instanceof InventoryAllocationError ||
        err instanceof DealCommitConflictError
      ) {
        res.status(409).json({
          error:
            err instanceof InventoryAllocationError
              ? "insufficient_inventory"
              : "deal_commit_conflict",
          detail: err.message,
          ...(err instanceof InventoryAllocationError
            ? {
                dealItemId: err.itemId || null,
                requested: err.requested,
                allocated: err.allocated,
              }
            : {}),
        });
        return;
      }
      await recordSubmission(
        app,
        "submit",
        "error",
        err instanceof Error ? err.message : "Unknown LOS error",
        null,
      );
      res.status(502).json({
        error:
          "The lender's loan origination system rejected the submission. Try again or contact the lender.",
      });
    }
  },
);

router.post(
  "/finance-applications/:id/sync",
  async (req, res): Promise<void> => {
    const params = SyncFinanceApplicationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [app] = await db
      .select()
      .from(financeApplicationsTable)
      .where(
        and(
          eq(financeApplicationsTable.id, params.data.id),
          eq(financeApplicationsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!app) {
      res.status(404).json({ error: "Finance application not found" });
      return;
    }
    if (app.status === "pending") {
      res.status(400).json({
        error: "Submit the application to the lender before checking status.",
      });
      return;
    }

    const connector = getLosConnector();
    try {
      const result = await connector.getStatus(app);
      await recordSubmission(
        app,
        "sync",
        result.status,
        result.message,
        app.losReference,
        result.raw,
      );
      if (result.status === app.status) {
        res.json(UpdateFinanceApplicationResponse.parse(app));
        return;
      }
      const updated = await transitionFinanceStatus(
        app.id,
        result.status,
        result.message,
      );
      res.json(UpdateFinanceApplicationResponse.parse(updated));
    } catch (err) {
      req.log.error({ err, appId: app.id }, "LOS status sync failed");
      if (
        err instanceof InventoryAllocationError ||
        err instanceof DealCommitConflictError
      ) {
        res.status(409).json({
          error:
            err instanceof InventoryAllocationError
              ? "insufficient_inventory"
              : "deal_commit_conflict",
          detail: err.message,
          ...(err instanceof InventoryAllocationError
            ? {
                dealItemId: err.itemId || null,
                requested: err.requested,
                allocated: err.allocated,
              }
            : {}),
        });
        return;
      }
      res.status(502).json({
        error: "Could not reach the lender's loan origination system.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

router.get(
  "/finance-applications/:id/documents",
  async (req, res): Promise<void> => {
    const params = ListFinanceDocumentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const rows = await db
      .select()
      .from(financeDocumentsTable)
      .where(
        and(
          eq(financeDocumentsTable.applicationId, params.data.id),
          eq(financeDocumentsTable.dealerId, activeDealerId(res)),
        ),
      )
      .orderBy(desc(financeDocumentsTable.createdAt));
    res.json(ListFinanceDocumentsResponse.parse(rows));
  },
);

router.post(
  "/finance-applications/:id/documents",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const params = UploadFinanceDocumentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file provided (field name: file)" });
      return;
    }
    const docType = insertFinanceDocumentSchema.shape.type.safeParse(
      req.body?.type ?? "other",
    );
    if (!docType.success) {
      res.status(400).json({ error: "Invalid document type" });
      return;
    }
    const [app] = await db
      .select()
      .from(financeApplicationsTable)
      .where(
        and(
          eq(financeApplicationsTable.id, params.data.id),
          eq(financeApplicationsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!app) {
      res.status(404).json({ error: "Finance application not found" });
      return;
    }

    const key = await storage.save(req.file.buffer, req.file.originalname);
    const uploadedBy = res.locals.user?.name ?? res.locals.user?.email ?? null;
    const [doc] = await db
      .insert(financeDocumentsTable)
      .values({
        dealerId: app.dealerId,
        applicationId: params.data.id,
        type: docType.data,
        fileName: req.file.originalname,
        storageKey: key,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        uploadedBy,
      })
      .returning();
    res.status(201).json(UploadFinanceDocumentResponse.parse(doc));
  },
);

router.get(
  "/finance-applications/:id/documents/:docId/download",
  async (req, res): Promise<void> => {
    const params = DownloadFinanceDocumentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [doc] = await db
      .select()
      .from(financeDocumentsTable)
      .where(
        and(
          eq(financeDocumentsTable.id, params.data.docId),
          eq(financeDocumentsTable.applicationId, params.data.id),
          eq(financeDocumentsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    try {
      const stream = await storage.stream(doc.storageKey);
      res.setHeader("Content-Type", doc.mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${doc.fileName.replace(/"/g, "")}"`,
      );
      stream.pipe(res);
    } catch (err) {
      req.log.error({ err, docId: doc.id }, "Document file missing on disk");
      res.status(404).json({ error: "Document file not found" });
    }
  },
);

router.delete(
  "/finance-applications/:id/documents/:docId",
  async (req, res): Promise<void> => {
    const params = DeleteFinanceDocumentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [doc] = await db
      .select()
      .from(financeDocumentsTable)
      .where(
        and(
          eq(financeDocumentsTable.id, params.data.docId),
          eq(financeDocumentsTable.applicationId, params.data.id),
          eq(financeDocumentsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (doc) {
      await storage.delete(doc.storageKey);
      await db
        .delete(financeDocumentsTable)
        .where(eq(financeDocumentsTable.id, doc.id));
    }
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Banks registry
// ---------------------------------------------------------------------------

router.get("/banks", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(banksTable)
    .where(eq(banksTable.dealerId, activeDealerId(res)))
    .orderBy(banksTable.name);
  res.json(ListBanksResponse.parse(rows));
});

router.post("/banks", async (req, res): Promise<void> => {
  const parsed = CreateBankBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [bank] = await db
    .insert(banksTable)
    .values({ ...parsed.data, dealerId: activeDealerId(res) })
    .returning();
  res.status(201).json(CreateBankResponse.parse(bank));
});

router.patch("/banks/:id", async (req, res): Promise<void> => {
  const params = UpdateBankParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBankBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [bank] = await db
    .update(banksTable)
    .set(parsed.data)
    .where(
      and(
        eq(banksTable.id, params.data.id),
        eq(banksTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!bank) {
    res.status(404).json({ error: "Bank not found" });
    return;
  }
  res.json(UpdateBankResponse.parse(bank));
});

// ---------------------------------------------------------------------------
// Invoices, payments, receipts, outstanding balances
// ---------------------------------------------------------------------------

router.get("/invoices", async (req, res): Promise<void> => {
  const query = ListInvoicesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.dealerId, activeDealerId(res)),
        ...(query.data.status
          ? [eq(invoicesTable.status, query.data.status)]
          : []),
      ),
    )
    .orderBy(desc(invoicesTable.createdAt));
  res.json(ListInvoicesResponse.parse(rows));
});

router.post("/invoices", idempotent("invoices.create"), async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const invoice = await issueInvoice({
    dealerId: activeDealerId(res),
    kind: parsed.data.kind ?? "final",
    customerName: parsed.data.customerName,
    amount: parsed.data.amount,
    customerId: parsed.data.customerId,
    dealId: parsed.data.dealId,
    applicationId: parsed.data.applicationId,
    description: parsed.data.description,
    dueDate: parsed.data.dueDate,
  });
  res.status(201).json(CreateInvoiceResponse.parse(invoice));
});

router.patch("/invoices/:id", async (req, res): Promise<void> => {
  const params = UpdateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Void guard (L6): an invoice with applied funds cannot be voided
  // directly — the payments must be reversed (negative payment) first so
  // the ledger stays append-only and every dollar has a receipt trail.
  let voiding = false;
  if (parsed.data.status === "void") {
    const [existing] = await db
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, params.data.id),
          eq(invoicesTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    if (existing.status !== "void") {
      const paid = await invoicePaidTotal(existing.id);
      if (paid > 0.005) {
        res.status(422).json({
          error: "refund_required",
          paid,
          hint: "Reverse the applied payments (negative payment) before voiding this invoice",
        });
        return;
      }
      voiding = true;
    }
  }
  const [invoice] = await db
    .update(invoicesTable)
    .set(parsed.data)
    .where(
      and(
        eq(invoicesTable.id, params.data.id),
        eq(invoicesTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  // ERPNext accounting sync: voiding mirrors as a Sales Invoice cancellation.
  if (voiding) {
    queueInvoiceSync(invoice.dealerId, invoice.id, "cancel");
  }
  res.json(UpdateInvoiceResponse.parse(invoice));
});

router.get("/payments", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.dealerId, activeDealerId(res)))
    .orderBy(desc(paymentsTable.createdAt));
  res.json(ListPaymentsResponse.parse(rows));
});

router.post("/payments", idempotent("payments.create"), async (req, res): Promise<void> => {
  const parsed = CreatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.amount === 0) {
    res.status(400).json({ error: "Payment amount cannot be zero" });
    return;
  }

  // L9 refund execution: a payment referencing a refund_release gate must be
  // a negative amount and the gate must already be manager-approved.
  let refundGate: typeof gatesTable.$inferSelect | null = null;
  if (parsed.data.gateId !== undefined) {
    const [gate] = await db
      .select()
      .from(gatesTable)
      .where(
        and(
          eq(gatesTable.id, parsed.data.gateId),
          eq(gatesTable.dealerId, activeDealerId(res)),
          eq(gatesTable.type, "refund_release"),
        ),
      );
    if (!gate) {
      res.status(404).json({ error: "Refund gate not found" });
      return;
    }
    if (gate.status !== "approved" && gate.status !== "adjusted") {
      res.status(422).json({
        error: "gate_not_approved",
        unmet: [
          "The refund_release gate must be approved by a manager before finance can execute the refund",
        ],
      });
      return;
    }
    if (parsed.data.amount >= 0) {
      res.status(400).json({
        error: "A refund against a refund_release gate must be a negative amount",
      });
      return;
    }
    const [existing] = await db
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(
        and(
          eq(paymentsTable.gateId, gate.id),
          eq(paymentsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (existing) {
      res.status(409).json({
        error: "refund_already_recorded",
        unmet: [`Refund for gate #${gate.id} was already recorded (payment #${existing.id})`],
      });
      return;
    }
    // Manager-approved cap: finance cannot refund more than the gate amount.
    if (gate.amount != null && Math.abs(parsed.data.amount) > gate.amount + 0.005) {
      res.status(422).json({
        error: "refund_exceeds_approved",
        unmet: [
          `Refund of $${Math.abs(parsed.data.amount).toFixed(2)} exceeds the manager-approved amount of $${gate.amount.toFixed(2)} for gate #${gate.id}`,
        ],
      });
      return;
    }
    refundGate = gate;
  }
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.id, parsed.data.invoiceId),
        eq(invoicesTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  if (invoice.status === "void") {
    res.status(409).json({ error: "invoice_void" });
    return;
  }
  const isReversal = parsed.data.amount < 0;
  if (invoice.status === "paid" && !isReversal) {
    res.status(409).json({ error: "invoice_already_paid" });
    return;
  }

  // L9: the refund must be posted against an invoice actually linked to the
  // record the gate was raised for — never an unrelated invoice.
  if (refundGate) {
    let linked = false;
    if (refundGate.refType === "deal" && refundGate.refId != null) {
      linked = invoice.dealId === refundGate.refId;
    } else if (refundGate.refType === "booking" && refundGate.refId != null) {
      const [booking] = await db
        .select({ dealId: bookingsTable.dealId })
        .from(bookingsTable)
        .where(
          and(
            eq(bookingsTable.id, refundGate.refId),
            eq(bookingsTable.dealerId, activeDealerId(res)),
          ),
        );
      linked = booking?.dealId != null && invoice.dealId === booking.dealId;
    }
    if (!linked) {
      res.status(422).json({
        error: "invoice_not_linked_to_gate",
        unmet: [
          `Invoice #${invoice.id} is not linked to the ${refundGate.refType} that refund gate #${refundGate.id} was raised for`,
        ],
      });
      return;
    }
  }

  // All monetary guards (overpayment, reversal floor, duplicate reference)
  // run INSIDE applyPayment's transaction under an invoice row lock, so
  // concurrent postings cannot race past them.
  const receivedBy = res.locals.user?.name ?? res.locals.user?.email ?? null;
  let result;
  try {
    result = await applyPayment({
      invoice,
      amount: parsed.data.amount,
      method: parsed.data.method,
      reference: parsed.data.reference ?? null,
      receivedBy,
      confirmDuplicate: parsed.data.confirmDuplicate === true,
      gateId: refundGate?.id ?? null,
    });
  } catch (err) {
    if (err instanceof PaymentGuardError) {
      switch (err.code) {
        case "invoice_void":
        case "invoice_already_paid":
          res.status(409).json({ error: err.code });
          return;
        case "reversal_exceeds_paid":
          res.status(422).json({ error: err.code, ...err.extra });
          return;
        case "overpayment":
          res.status(422).json({ error: err.code, ...err.extra });
          return;
        case "duplicate_reference":
          res.status(409).json({
            error: err.code,
            ...err.extra,
            hint: "A payment with this reference already exists — resend with confirmDuplicate:true if it is genuinely a second payment",
          });
          return;
        case "refund_already_recorded":
          res.status(409).json({
            error: err.code,
            unmet: [
              `Refund for gate #${refundGate?.id} was already recorded by a concurrent request`,
            ],
          });
          return;
      }
    }
    throw err;
  }
  await logPaymentEvent(
    invoice,
    result.payment.amount,
    result.payment.method,
    result.receipt.receiptNumber,
  );

  // L9 refund side effects: the gate link is stamped on the ledger row inside
  // applyPayment's transaction (unique per gate); here we flip the downstream
  // records to their refunded terminal states and confirm to the customer
  // (idempotent per gate via the email dedupe key).
  const payment = result.payment;
  if (refundGate) {
    const dealerId = activeDealerId(res);
    let vehicleId: number | null = null;
    if (refundGate.refType === "deal" && refundGate.refId != null) {
      const [deal] = await db
        .select()
        .from(dealsTable)
        .where(
          and(
            eq(dealsTable.id, refundGate.refId),
            eq(dealsTable.dealerId, dealerId),
          ),
        );
      if (deal) {
        vehicleId = deal.vehicleId;
        await db
          .update(dealsTable)
          .set({ depositPaid: false })
          .where(and(eq(dealsTable.id, deal.id), eq(dealsTable.dealerId, dealerId)));
        await db
          .update(bookingsTable)
          .set({ paymentStatus: "refunded" })
          .where(
            and(
              eq(bookingsTable.dealId, deal.id),
              eq(bookingsTable.dealerId, dealerId),
              eq(bookingsTable.status, "cancelled"),
            ),
          );
      }
    } else if (refundGate.refType === "booking" && refundGate.refId != null) {
      const [booking] = await db
        .update(bookingsTable)
        .set({ paymentStatus: "refunded" })
        .where(
          and(
            eq(bookingsTable.id, refundGate.refId),
            eq(bookingsTable.dealerId, dealerId),
          ),
        )
        .returning();
      if (booking) vehicleId = booking.vehicleId;
    }

    const refundAmount = Math.abs(result.payment.amount);
    const fmt = (n: number) =>
      `GY$${Math.round(n).toLocaleString("en-US")}`;
    await logCancellationEvent({
      dealerId,
      customerId: refundGate.customerId,
      refType: refundGate.refType === "booking" ? "booking" : "deal",
      refId: refundGate.refId ?? 0,
      title: "Refund executed",
      detail: `Finance recorded a refund of ${fmt(refundAmount)} (receipt ${result.receipt.receiptNumber}) against gate #${refundGate.id}. The customer has been notified.`,
      actor: receivedBy ?? "Finance",
    });

    if (refundGate.customerId != null) {
      const [customer] = await db
        .select({
          name: customersTable.name,
          email: customersTable.email,
          phone: customersTable.phone,
        })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.id, refundGate.customerId),
            eq(customersTable.dealerId, dealerId),
          ),
        );
      let vehicleName = "vehicle";
      if (vehicleId != null) {
        const [v] = await db
          .select({
            year: vehiclesTable.year,
            make: vehiclesTable.make,
            model: vehiclesTable.model,
          })
          .from(vehiclesTable)
          .where(
            and(
              eq(vehiclesTable.id, vehicleId),
              eq(vehiclesTable.dealerId, dealerId),
            ),
          );
        if (v) vehicleName = `${v.year} ${v.make} ${v.model}`;
      }
      // R6.2 #11 Refund executed → customer confirmation on Email + WhatsApp,
      // both keyed on the payment (refund:paid:{paymentId}:channel).
      if (customer) {
        notifyRefundPaid({
          dealerId,
          paymentId: result.payment.id,
          customerId: refundGate.customerId,
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          amount: fmt(refundAmount),
          reference: result.receipt.receiptNumber,
          vehicle: vehicleName,
        });
      }
    }
  }

  res.status(201).json(CreatePaymentResponse.parse(payment));
});

router.get("/receipts", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(receiptsTable)
    .where(eq(receiptsTable.dealerId, activeDealerId(res)))
    .orderBy(desc(receiptsTable.createdAt));
  res.json(ListReceiptsResponse.parse(rows));
});

router.get("/receipts/:id", async (req, res): Promise<void> => {
  const params = GetReceiptParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [receipt] = await db
    .select()
    .from(receiptsTable)
    .where(
      and(
        eq(receiptsTable.id, params.data.id),
        eq(receiptsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!receipt) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.json(GetReceiptResponse.parse(receipt));
});

router.get("/receipts/:id/pdf", async (req, res): Promise<void> => {
  const params = GetReceiptParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [receipt] = await db
    .select()
    .from(receiptsTable)
    .where(
      and(
        eq(receiptsTable.id, params.data.id),
        eq(receiptsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!receipt) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  const pdf = await buildReceiptPdf(
    receipt,
    await getDealerPdfBranding(receipt.dealerId),
  );
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="${receipt.receiptNumber}.pdf"`,
    )
    .send(pdf);
});

router.get("/outstanding-balances", async (_req, res): Promise<void> => {
  const invoices = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.dealerId, activeDealerId(res)),
        inArray(invoicesTable.status, ["issued", "partially_paid"]),
      ),
    )
    .orderBy(desc(invoicesTable.createdAt));
  const sums = invoices.length
    ? await db
        .select({
          invoiceId: paymentsTable.invoiceId,
          paid: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)::float`,
        })
        .from(paymentsTable)
        .where(
          inArray(
            paymentsTable.invoiceId,
            invoices.map((i) => i.id),
          ),
        )
        .groupBy(paymentsTable.invoiceId)
    : [];
  const paidBy = new Map(sums.map((s) => [s.invoiceId, s.paid]));
  res.json(
    ListOutstandingBalancesResponse.parse(
      invoices.map((i) => {
        const paidAmount = paidBy.get(i.id) ?? 0;
        return {
          invoiceId: i.id,
          invoiceNumber: i.invoiceNumber,
          customerId: i.customerId,
          customerName: i.customerName,
          amount: i.amount,
          paidAmount,
          balance: Math.max(i.amount - paidAmount, 0),
          status: i.status,
          dueDate: i.dueDate,
          createdAt: i.createdAt,
        };
      }),
    ),
  );
});

export default router;
