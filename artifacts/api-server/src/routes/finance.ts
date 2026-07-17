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
  insertFinanceDocumentSchema,
  type FinanceApplication,
} from "@workspace/db";
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
  ListOutstandingBalancesResponse,
} from "@workspace/api-zod";
import { storage } from "../lib/storage";
import { getLosConnector } from "../lib/los";
import { activeDealerId } from "../middlewares/rbac";
import {
  applyFinanceStatusEffects,
  transitionFinanceStatus,
  statusEvent,
} from "../lib/finance-effects";

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

  const [application] = await db
    .update(financeApplicationsTable)
    .set({
      ...rest,
      ...(statusChanged
        ? {
            status,
            statusHistory: [...before.statusHistory, statusEvent(status, note)],
            ...(status === "approved" || status === "declined"
              ? { decisionAt: new Date() }
              : {}),
            ...(status === "disbursed" ? { disbursedAt: new Date() } : {}),
          }
        : {}),
    })
    .where(
      and(
        eq(financeApplicationsTable.id, params.data.id),
        eq(financeApplicationsTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();

  if (!application) {
    res.status(404).json({ error: "Finance application not found" });
    return;
  }
  if (statusChanged) {
    await applyFinanceStatusEffects(application, before.status, note);
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

router.post("/invoices", async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const invoice = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(invoicesTable)
      .values({ ...parsed.data, dealerId: activeDealerId(res), invoiceNumber: "PENDING" })
      .returning();
    const [numbered] = await tx
      .update(invoicesTable)
      .set({
        invoiceNumber: `INV-${new Date().getFullYear()}-${String(row!.id).padStart(4, "0")}`,
      })
      .where(eq(invoicesTable.id, row!.id))
      .returning();
    return numbered!;
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

router.post("/payments", async (req, res): Promise<void> => {
  const parsed = CreatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.amount <= 0) {
    res.status(400).json({ error: "Payment amount must be positive" });
    return;
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
    res.status(400).json({ error: "Cannot pay a void invoice" });
    return;
  }
  if (invoice.status === "paid") {
    res.status(400).json({ error: "Invoice is already fully paid" });
    return;
  }

  const receivedBy = res.locals.user?.name ?? res.locals.user?.email ?? null;

  const payment = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(paymentsTable)
      .values({
        dealerId: invoice.dealerId,
        invoiceId: invoice.id,
        customerName: invoice.customerName,
        amount: parsed.data.amount,
        method: parsed.data.method,
        reference: parsed.data.reference ?? null,
        receivedBy,
      })
      .returning();

    const [{ paid }] = await tx
      .select({
        paid: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)::float`,
      })
      .from(paymentsTable)
      .where(eq(paymentsTable.invoiceId, invoice.id));

    await tx
      .update(invoicesTable)
      .set({
        status: paid >= invoice.amount ? "paid" : "partially_paid",
      })
      .where(eq(invoicesTable.id, invoice.id));

    await tx.insert(receiptsTable).values({
      dealerId: invoice.dealerId,
      receiptNumber: `RCT-${new Date().getFullYear()}-${String(row!.id).padStart(4, "0")}`,
      paymentId: row!.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName,
      amount: row!.amount,
      method: row!.method,
      issuedBy: receivedBy,
    });

    return row!;
  });

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
