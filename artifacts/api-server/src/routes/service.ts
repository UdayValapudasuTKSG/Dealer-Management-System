import { getDealerPdfBranding } from "../lib/dealer-branding";
import { moveStock, releaseHold } from "../lib/parts-inventory";
import { issuedUnits, issueJobParts, reserveJobPart, releaseJobPartHolds } from "../lib/job-part-stock";
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  buildCoverageCertificatePdf,
  buildServiceInvoicePdf,
  buildServiceReceiptPdf,
} from "../lib/document-pdfs";
import {
  dealerTimezone,
  formatDealerDate,
  formatDealerDateTime,
  zonedDayKey,
  zonedParts,
  zonedTimeToUtc,
} from "../lib/timezone";
import { getServiceSettings } from "../lib/service-settings";
import {
  computeLateSurcharge,
  ensureInitialJobCard,
  initialJobCardQuoteTotal,
} from "../lib/initial-job-card";
import {
  calculateLabourRateGyd,
  canonicalServiceBrand,
  labourUsdPerHourForBrand,
  resolveNewCardLabourRate,
  serviceBrandsFromInventoryMakes,
} from "../lib/service-labour-pricing";
import { buildServiceEstimateBreakdown } from "../lib/service-estimate-breakdown";
import { effectiveQuotedLaborHours } from "../lib/service-labor-hours";
import {
  clearEstimateStaffAcknowledgement,
  hasCurrentChargeableWorkAuthorization,
} from "../lib/service-estimate-gate";
import { invalidateServiceEstimate } from "../lib/service-estimate-invalidation";
import { renderReportExport } from "../lib/report-export";
import { queueCustomerSync } from "../lib/erpnext/entities";
import { dealerExchangeRate } from "../lib/invoicing";
import { and, desc, eq, getTableColumns, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  serviceOrdersTable,
  assetsTable,
  vehiclesTable,
  dealsTable,
  jobCardsTable,
  jobCardPartsTable,
  partsTable,
  coveragePlansTable,
  serviceInvoicesTable,
  customersTable,
  dealersTable,
  usersTable,
  rolesTable,
  dealerUsersTable,
  gatesTable,
  timelineEventsTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  partCreditNotesTable,
  jobCardTechnicianNotesTable,
  externalJobCardPartsTable,
  tasksTable,
  emailLogsTable,
  technicianTimesheetEntriesTable,
  collisionClaimsTable,
  collisionSettlementsTable,
  collisionSupplementsTable,
  serviceEstimateDecisionsTable,
  vehicleOnboardingRequestsTable,
  vehicleOnboardingMediaTable,
  webhookEventsTable,
  type JobCard,
  type JobWaitingReason,
  type ServiceInvoice,
} from "@workspace/db";
import {
  CreateServiceOrderBody,
  ListServiceCustomerVehiclesParams,
  ListServiceCustomerVehiclesResponse,
  UpdateServiceOrderBody,
  UpdateServiceOrderParams,
  ListServiceOrdersQueryParams,
  ListServiceOrdersResponse,
  CreateServiceOrderResponse,
  UpdateServiceOrderResponse,
  SendServiceReminderParams,
  SendServiceReminderResponse,
  ConfirmServiceAppointmentParams,
  ConfirmServiceAppointmentBody,
  ConfirmServiceAppointmentResponse,
  GetServiceAppointmentConfirmationDeliveryResponse,
  ListServiceOrderOnboardingMediaParams,
  ListServiceOrderOnboardingMediaResponse,
  ReadServiceOrderOnboardingMediaParams,
  ListServiceTechniciansResponse,
  ListJobCardsQueryParams,
  ListJobCardsResponse,
  GetJobCardParams,
  GetJobCardResponse,
  ListJobCardHistoryQueryParams,
  ListJobCardHistoryResponse,
  ToggleJobCardTimerParams,
  ToggleJobCardTimerBody,
  ToggleJobCardTimerResponse,
  ReopenJobCardParams,
  ReopenJobCardBody,
  ReopenJobCardResponse,
  CreateJobCardBody,
  CreateJobCardResponse,
  UpdateJobCardParams,
  UpdateJobCardBody,
  UpdateJobCardResponse,
  ListJobCardPartsParams,
  ListJobCardPartsResponse,
  ListJobCardExternalPartsParams,
  ListJobCardExternalPartsResponse,
  AddJobCardPartParams,
  AddJobCardPartBody,
  AddJobCardPartResponse,
  CreateJobCardInvoiceParams,
  CreateJobCardInvoiceResponse,
  ListServiceInvoicesQueryParams,
  ListServiceInvoicesResponse,
  UpdateServiceInvoiceParams,
  UpdateServiceInvoiceBody,
  UpdateServiceInvoiceResponse,
  ListCoveragePlansQueryParams,
  ListCoveragePlansResponse,
  CreateCoveragePlanBody,
  CreateCoveragePlanResponse,
  UpdateCoveragePlanParams,
  UpdateCoveragePlanBody,
  UpdateCoveragePlanResponse,
  SendCoverageReminderParams,
  SendCoverageReminderResponse,
  AdvanceServiceOrderParams,
  AdvanceServiceOrderBody,
  AdvanceServiceOrderResponse,
  RolloverJobCardParams,
  RolloverJobCardBody,
  RolloverJobCardResponse,
  ApproveJobCardRolloverParams,
  ApproveJobCardRolloverBody,
  ApproveJobCardRolloverResponse,
  DecideJobCardSurchargeParams,
  DecideJobCardSurchargeBody,
  DecideJobCardSurchargeResponse,
  RequestServiceInvoiceDiscountParams,
  RequestServiceInvoiceDiscountBody,
  RequestServiceInvoiceDiscountResponse,
  DecideServiceInvoiceDiscountParams,
  DecideServiceInvoiceDiscountBody,
  DecideServiceInvoiceDiscountResponse,
  AdjustServiceInvoiceParams,
  AdjustServiceInvoiceBody,
  AdjustServiceInvoiceResponse,
  ListJobCardCreditNotesParams,
  ListJobCardCreditNotesResponse,
  CreateJobCardCreditNoteParams,
  CreateJobCardCreditNoteBody,
  CreateJobCardCreditNoteResponse,
  ListWorkshopWipQueryParams,
  ListWorkshopWipResponse,
  UpdateJobCardWaitingParams,
  UpdateJobCardWaitingBody,
  UpdateJobCardWaitingResponse,
  ResendJobCardEstimateParams,
  ResendJobCardEstimateResponse,
  AcknowledgeJobCardEstimateParams,
  AcknowledgeJobCardEstimateResponse,
  GetJobCardEstimatePreviewParams,
  GetJobCardEstimatePreviewResponse,
  ApplyCurrentJobCardLabourRateParams,
  ApplyCurrentJobCardLabourRateResponse,
  GetServiceBookingLabourRatesResponse,
} from "@workspace/api-zod";
import { checkLowStockCrossing } from "./parts";
import {
  enqueueStockEntrySync,
  enqueuePurchaseOrderSync,
} from "../lib/erpnext/parts-sync";
import {
  queueServiceInvoiceCreditSync,
  queueServiceInvoiceSync,
} from "../lib/erpnext/service-invoice-credits";
import {
  onServiceOrderBooked,
  onServiceOrderStatusChanged,
  onJobCardRolloverApproved,
  onServiceInvoiceIssued,
  onJobCardIntakeRecorded,
  onServiceAppointmentChanged,
  onJobCardStatusChanged,
  preflightServiceEstimateQuote,
  queueServiceEstimateQuote,
} from "../lib/email-triggers";
import {
  enqueueEmail,
  enqueueWhatsapp,
  isDefinitivelyRejectedWhatsapp,
  retryRejectedWhatsappOutboxItem,
  notifyUser,
  whatsappRetryPolicyError,
  whatsappOutboxDisposition,
} from "../lib/email";
import { generalManagers } from "../lib/notify-matrix";
import { activeDealerId } from "../middlewares/rbac";
import { idempotent } from "../middlewares/idempotency";
import { resolveDealerUserIdByName } from "../lib/user-lookup";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { computeServiceTax, ensureDealerTaxes } from "../lib/taxes";
import { logger } from "../lib/logger";
import { coordinateCollisionClaim } from "../lib/collision-coordinator";
import { effectiveServiceReminderRecipient } from "../lib/service-booking-contact";
import { getChannelByDealerId } from "../lib/whatsapp-channel";
import {
  diagnoseWhatsappChannel,
  isApprovedWhatsappTemplateReady,
} from "../lib/whatsapp";
import { normalizeWhatsappPhone } from "../lib/whatsapp-phone";
import {
  renderServiceAppointmentConfirmedBody,
  SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT,
  SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE,
} from "../lib/service-appointment-whatsapp";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const ACTIVE_JOB_CARD_STATUSES = ["open", "in_progress", "on_hold"] as const;

/**
 * Service Manager / Management sign-off check for rollover approvals and
 * discount decisions. Permission-based checks stay in the authorize
 * middleware; this narrows WHO within the service module may sign off.
 */
function isServiceApprover(user: {
  roleName?: string | null;
  isSuperAdmin?: boolean;
} | null | undefined): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  const role = user.roleName ?? "";
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(
    role,
  );
}

function toDateString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return undefined;
}

function serviceAppointmentConfirmationDelivery(
  row:
    | {
        status: string;
        deliveryStatus: string | null;
        recipient: string;
        attempts: number;
        lastError: string | null;
        providerMessageId: string | null;
        sentAt: Date | null;
        deliveredAt: Date | null;
        readAt: Date | null;
        payload: Record<string, string>;
      }
    | undefined,
) {
  if (!row) {
    return {
      state: "not_queued",
      recipient: null,
      attempts: 0,
      lastError: null,
      providerMessageId: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      canRetry: false,
    };
  }
  const state =
    row.deliveryStatus === "read"
      ? "read"
      : row.deliveryStatus === "delivered"
        ? "delivered"
        : row.deliveryStatus === "accepted" || row.status === "sent"
          ? "accepted"
          : row.deliveryStatus === "failed" || row.status === "failed"
            ? "failed"
            : row.deliveryStatus === "cancelled" || row.status === "cancelled"
              ? "cancelled"
              : "queued";
  return {
    state,
    recipient: row.recipient,
    attempts: row.attempts,
    lastError: row.lastError,
    providerMessageId: row.providerMessageId,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
    canRetry: isDefinitivelyRejectedWhatsapp(row),
  };
}

function hasValidServiceAppointmentTemplatePayload(
  payload: Record<string, string>,
): boolean {
  if (
    payload.whatsappTemplateName !==
    SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name
  ) {
    return false;
  }
  try {
    const bodyParameters = JSON.parse(
      payload.whatsappTemplateBodyParametersJson ?? "null",
    ) as unknown;
    return (
      Array.isArray(bodyParameters) &&
      bodyParameters.length ===
        SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT &&
      bodyParameters.every(
        (parameter) => typeof parameter === "string" && parameter.trim(),
      )
    );
  } catch {
    return false;
  }
}

/** Read-only preflight. A confirmation is never queued/replayed until the
 * dealer's actual Meta template exactly matches the immutable approved
 * contract; this blocks rather than guessing a locale or changing wording. */
async function serviceAppointmentTemplateReadinessError(
  dealerId: number,
): Promise<string | null> {
  const channel = await getChannelByDealerId(dealerId);
  if (!channel?.wabaId) {
    return "WhatsApp is not configured with a WABA for this dealership";
  }
  try {
    const diagnostic = await diagnoseWhatsappChannel({
      accessToken: channel.accessToken,
      phoneNumberId: channel.phoneNumberId,
      wabaId: channel.wabaId,
      templateName: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
      approvedTemplateLanguage: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
      approvedTemplateBody: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body,
      approvedTemplateHeader: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
      approvedTemplateParameterCount:
        SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT,
    });
    return isApprovedWhatsappTemplateReady(diagnostic)
      ? null
      : "The approved WhatsApp appointment template is not ready. Reconcile its Meta header, body, placeholders, and locale before sending.";
  } catch {
    return "The approved WhatsApp appointment template could not be verified safely. No customer message was queued.";
  }
}

async function customerEmail(
  customerId: number | null | undefined,
  dealerId: number,
): Promise<{ email: string | null; name: string | null; phone: string | null }> {
  if (customerId == null) return { email: null, name: null, phone: null };
  const [row] = await db
    .select({
      email: customersTable.email,
      name: customersTable.name,
      phone: customersTable.phone,
    })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
        isNull(customersTable.deletedAt),
        isNull(customersTable.erasedAt),
      ),
    );
  return {
    email: effectiveServiceReminderRecipient(row?.email),
    name: row?.name ?? null,
    phone: row?.phone?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Service orders (bookings)
// ---------------------------------------------------------------------------

/** Technicians only ever see their own assigned bookings (RBAC "My Day"). */
export function isTechnicianRole(user: {
  roleName?: string | null;
  isSuperAdmin?: boolean;
} | null | undefined): boolean {
  if (!user || user.isSuperAdmin) return false;
  return /technician/i.test(user.roleName ?? "");
}

/**
 * Round-robin technician auto-assignment with capacity awareness.
 * Eligibility: booked hours on the scheduled date + this job's hours must fit
 * inside the GM-configured workday. Among eligible technicians, pick the
 * least-loaded; tie-break round-robin by least-recently-assigned.
 * Returns null when every technician's day is already full.
 */
async function pickTechnicianRoundRobin(
  dealerId: number,
  scheduledDate: string,
  jobHours: number,
  workHoursPerDay: number,
  tx: Pick<typeof db, "select"> = db,
): Promise<{ id: number; name: string; overCapacity: boolean } | null> {
  const techs = await tx
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolesTable.name, "Technician"),
      ),
    );
  if (techs.length === 0) return null;

  // One pass: per-technician booked hours on the date + last assignment time.
  const load = await tx
    .select({
      technicianUserId: serviceOrdersTable.technicianUserId,
      bookedHours: sql<number>`coalesce(sum(case when ${serviceOrdersTable.scheduledDate} = ${scheduledDate} and ${serviceOrdersTable.status} not in ('cancelled','closed') then ${serviceOrdersTable.estimatedHours} else 0 end), 0)`,
      lastAssignedAt: sql<string | null>`max(${serviceOrdersTable.createdAt})`,
    })
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, dealerId),
        sql`${serviceOrdersTable.technicianUserId} is not null`,
      ),
    )
    .groupBy(serviceOrdersTable.technicianUserId);
  const byTech = new Map(load.map((l) => [l.technicianUserId, l]));

  const candidates = techs.map((t) => {
    const l = byTech.get(t.id);
    return {
      id: t.id,
      name: t.name ?? t.email ?? `User #${t.id}`,
      booked: Number(l?.bookedHours ?? 0),
      lastAssignedAt: l?.lastAssignedAt ?? null,
    };
  });

  // FIFO ordering: never-assigned first, then oldest last assignment.
  const fifo = (a: (typeof candidates)[number], b: (typeof candidates)[number]) => {
    if (a.lastAssignedAt === b.lastAssignedAt) return a.id - b.id;
    if (a.lastAssignedAt == null) return -1;
    if (b.lastAssignedAt == null) return 1;
    return a.lastAssignedAt < b.lastAssignedAt ? -1 : 1;
  };

  const eligible = candidates.filter(
    (t) => t.booked + jobHours <= workHoursPerDay,
  );
  if (eligible.length > 0) {
    eligible.sort((a, b) =>
      a.booked !== b.booked ? a.booked - b.booked : fifo(a, b),
    );
    const top = eligible[0]!;
    return { id: top.id, name: top.name, overCapacity: false };
  }

  // Everyone is full: still assign — strict FIFO across all technicians so
  // the overflow lands on whoever has waited longest since their last job.
  candidates.sort(fifo);
  const next = candidates[0]!;
  return { id: next.id, name: next.name, overCapacity: true };
}

router.get("/service-orders", async (req, res): Promise<void> => {
  const query = ListServiceOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const fromDate = toDateString(query.data.from);
  const toDate = toDateString(query.data.to);
  if (fromDate && toDate && fromDate > toDate) {
    res.status(400).json({ error: "The start date must be on or before the end date" });
    return;
  }

  // Technicians see their own work plus unclaimed work they may self-claim,
  // never bookings assigned to another technician.
  const viewer = res.locals.user;
  const rows = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, activeDealerId(res)),
        query.data.status
          ? eq(serviceOrdersTable.status, query.data.status)
          : undefined,
        fromDate
          ? gte(serviceOrdersTable.scheduledDate, fromDate)
          : undefined,
        toDate
          ? lte(serviceOrdersTable.scheduledDate, toDate)
          : undefined,
        isTechnicianRole(viewer)
          ? or(
              eq(serviceOrdersTable.technicianUserId, viewer!.id),
              isNull(serviceOrdersTable.technicianUserId),
            )
          : undefined,
      ),
    )
    .orderBy(desc(serviceOrdersTable.scheduledDate));

  const customerIds = [
    ...new Set(
      rows
        .map((row) => row.customerId)
        .filter((customerId): customerId is number => customerId != null),
    ),
  ];
  const customerEmailRows =
    customerIds.length > 0
      ? await db
          .select({ id: customersTable.id, email: customersTable.email })
          .from(customersTable)
          .where(
            and(
              eq(customersTable.dealerId, activeDealerId(res)),
              inArray(customersTable.id, customerIds),
              isNull(customersTable.deletedAt),
              isNull(customersTable.erasedAt),
            ),
          )
      : [];
  const customerEmails = new Map(
    customerEmailRows.map((customer) => [customer.id, customer.email?.trim() || null]),
  );
  res.json(
    ListServiceOrdersResponse.parse(
      rows.map((row) => ({
        ...row,
        customerEmail:
          row.customerId == null
            ? null
            : effectiveServiceReminderRecipient(customerEmails.get(row.customerId)),
      })),
    ),
  );
});

router.get("/service-booking/labour-rates", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const [settings, inventoryMakes] = await Promise.all([
    getServiceSettings(dealerId),
    db
      .selectDistinct({ make: vehiclesTable.make })
      .from(vehiclesTable)
      .where(and(
        eq(vehiclesTable.dealerId, dealerId),
        isNull(vehiclesTable.deletedAt),
      )),
  ]);
  // This is intentionally scoped to this dealer's non-deleted inventory and
  // does not filter by status: sold/history rows keep the taxonomy stable.
  // Configured overrides are pricing data only and must not add selector values.
  const brands = serviceBrandsFromInventoryMakes(inventoryMakes.map(({ make }) => make));
  res.json(GetServiceBookingLabourRatesResponse.parse({
    labourUsdToGydRate: settings.labourUsdToGydRate,
    defaultLabourUsdPerHour: settings.labourUsdPerHour,
    defaultLabourGydPerHour: settings.labourGydPerHour,
    brands,
    brandLabourRates: settings.brandLabourRates.map((rate) => ({
      ...rate,
      labourGydPerHour: calculateLabourRateGyd(
        settings.labourUsdToGydRate,
        rate.labourUsdPerHour,
      ),
    })),
  }));
});

/**
 * Canonical customer vehicle associations used by service booking forms.
 *
 * Assets are the ownership record created at delivery.  Delivered deals are
 * retained as a legacy fallback for dealers that predate asset creation. Both
 * reads are constrained by the active dealer and the customer id; no
 * inventory-wide vehicle list is exposed to the caller.
 */
router.get("/service-orders/customer-vehicles/:customerId", async (req, res): Promise<void> => {
  const params = ListServiceCustomerVehiclesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const customerId = params.data.customerId;
  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
        isNull(customersTable.deletedAt),
        isNull(customersTable.erasedAt),
      ),
    )
    .limit(1);
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const [assetRows, deliveredDeals, vehicles] = await Promise.all([
    db
      .select({
        assetId: assetsTable.id,
        vehicleId: assetsTable.vehicleId,
        status: assetsTable.status,
        deliveredAt: assetsTable.deliveredAt,
      })
      .from(assetsTable)
      .where(
        and(
          eq(assetsTable.dealerId, dealerId),
          eq(assetsTable.accountId, customerId),
        ),
      )
      .orderBy(desc(assetsTable.deliveredAt)),
    db
      .select({
        vehicleId: dealsTable.vehicleId,
        createdAt: dealsTable.createdAt,
      })
      .from(dealsTable)
      .where(
        and(
          eq(dealsTable.dealerId, dealerId),
          eq(dealsTable.customerId, customerId),
          eq(dealsTable.stage, "delivered"),
        ),
      )
      .orderBy(desc(dealsTable.createdAt)),
    db
      .select({
        id: vehiclesTable.id,
        make: vehiclesTable.make,
        model: vehiclesTable.model,
        trim: vehiclesTable.trim,
        year: vehiclesTable.year,
        vin: vehiclesTable.vin,
        registration: vehiclesTable.registration,
      })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.dealerId, dealerId),
          isNull(vehiclesTable.deletedAt),
        ),
      ),
  ]);

  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const associations = new Map<number, {
    vehicleId: number;
    assetId: number | null;
    label: string;
    make: string;
    model: string;
    year: number;
    trim: string | null;
    vin: string | null;
    registration: string | null;
    status: "active" | "transferred";
  }>();

  for (const asset of assetRows) {
    const vehicle = vehicleById.get(asset.vehicleId);
    if (!vehicle) continue;
    associations.set(asset.vehicleId, {
      vehicleId: vehicle.id,
      assetId: asset.assetId,
      label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      trim: vehicle.trim,
      vin: vehicle.vin,
      registration: vehicle.registration,
      status: asset.status === "transferred" ? "transferred" : "active",
    });
  }

  // Legacy deliveries may not have an assets row. They are still canonical
  // ownership evidence because the deal reached the delivered stage.
  for (const deal of deliveredDeals) {
    if (associations.has(deal.vehicleId)) continue;
    const vehicle = vehicleById.get(deal.vehicleId);
    if (!vehicle) continue;
    associations.set(deal.vehicleId, {
      vehicleId: vehicle.id,
      assetId: null,
      label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      trim: vehicle.trim,
      vin: vehicle.vin,
      registration: vehicle.registration,
      status: "active",
    });
  }

  res.json(ListServiceCustomerVehiclesResponse.parse([...associations.values()]));
});

router.post("/service-orders", async (req, res): Promise<void> => {
  const normalizedBody =
    req.body && typeof req.body === "object"
      ? {
          ...req.body,
          ...(typeof req.body.vehicleInfo === "string"
            ? { vehicleInfo: req.body.vehicleInfo.trim() }
            : {}),
          ...(typeof req.body.vin === "string"
            ? { vin: req.body.vin.trim() }
            : {}),
          ...(typeof req.body.registrationNumber === "string"
            ? { registrationNumber: req.body.registrationNumber.trim() }
            : {}),
          ...(typeof req.body.customerEmail === "string"
            ? { customerEmail: req.body.customerEmail.trim() }
            : {}),
          ...(typeof req.body.brand === "string"
            ? { brand: canonicalServiceBrand(req.body.brand) }
            : {}),
        }
      : req.body;
  const parsed = CreateServiceOrderBody.safeParse(normalizedBody);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const createDealerId = activeDealerId(res);

  // Customer email capture: link the booking to a customer record by email so
  // confirmations and the completion invoice have a real recipient. Matches an
  // existing dealer customer first; otherwise creates one from name + email.
  const { customerEmail: bookingEmail, ...orderInput } = parsed.data;
  orderInput.vehicleInfo = orderInput.vehicleInfo.trim();
  orderInput.vin = orderInput.vin.trim();
  orderInput.registrationNumber = orderInput.registrationNumber.trim();
  const submittedPhone = orderInput.customerPhoneSnapshot?.trim() ?? null;
  if (submittedPhone && !validPhone(submittedPhone)) {
    res.status(422).json({ error: "customerPhoneSnapshot must be a valid phone number" });
    return;
  }
  let bookingCustomerId = orderInput.customerId;
  if (bookingEmail && bookingCustomerId == null) {
    const [existingCustomer] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.dealerId, createDealerId),
          sql`lower(${customersTable.email}) = ${bookingEmail.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (existingCustomer) {
      bookingCustomerId = existingCustomer.id;
    } else {
      const [created] = await db
        .insert(customersTable)
        .values({
          dealerId: createDealerId,
          name: orderInput.customerName?.trim() || bookingEmail,
          email: bookingEmail,
        })
        .returning({ id: customersTable.id });
      bookingCustomerId = created?.id;
      // ERPNext two-way sync: mirror the service-created account.
      if (created) queueCustomerSync(createDealerId, created.id);
    }
  } else if (bookingEmail && bookingCustomerId != null) {
    // Booking supplied both: backfill the customer's email if they have none.
    const [backfilled] = await db
      .update(customersTable)
      // updatedAt drives the ERPNext last-write-wins check.
      .set({ email: bookingEmail, updatedAt: new Date() })
      .where(
        and(
          eq(customersTable.id, bookingCustomerId),
          eq(customersTable.dealerId, createDealerId),
          isNull(customersTable.email),
        ),
      )
      .returning({ id: customersTable.id });
    // ERPNext two-way sync: push the contact-field change.
    if (backfilled) queueCustomerSync(createDealerId, backfilled.id);
  }
  // This contact value is an immutable operational snapshot. An explicit,
  // valid intake number wins; customer master data is only a creation-time
  // fallback and is never consulted by PATCH.
  const customerPhoneSnapshot =
    submittedPhone ?? await resolveCustomerPhoneSnapshot(bookingCustomerId, createDealerId);
  if (!customerPhoneSnapshot) {
    res.status(422).json({
      error: "A valid customer phone number is required to create a service order",
    });
    return;
  }

  const settings = await getServiceSettings(createDealerId);
  const estimatedHours = parsed.data.estimatedHours ?? settings.defaultJobHours;
  const scheduledDateStr = toDateString(parsed.data.scheduledDate)!;
  if (orderInput.vehicleId != null) {
    const [linkedVehicle] = await db
      .select({ make: vehiclesTable.make })
      .from(vehiclesTable)
      .where(and(
        eq(vehiclesTable.id, orderInput.vehicleId),
        eq(vehiclesTable.dealerId, createDealerId),
        isNull(vehiclesTable.deletedAt),
      ))
      .limit(1);
    if (!linkedVehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    orderInput.brand = canonicalServiceBrand(linkedVehicle.make);
  }

  // Stamp the technician's user ID so briefing scoping matches by ID, not name.
  let technicianUserId =
    parsed.data.technicianUserId ??
    (await resolveDealerUserIdByName(createDealerId, parsed.data.technician));
  let technicianName = parsed.data.technician;
  let assignmentNote: string | null = null;

  // Manual assignment by ID only: backfill the display name from the user
  // record so the booking card never shows "Unassigned" for an assigned tech.
  if (technicianUserId != null && !technicianName) {
    const [u] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, technicianUserId));
    technicianName = u?.name ?? u?.email ?? `User #${technicianUserId}`;
  }

  // Bookings are created unassigned by default — the workshop assigns a
  // technician later. Round-robin only runs when explicitly requested.
  const autoAssign =
    parsed.data.autoAssign === true &&
    technicianUserId == null &&
    !parsed.data.technician;

  // Pay-type resolution: explicit wins; warranty/recall work defaults to
  // warranty pay; otherwise an active coverage plan (by date window) for the
  // customer flips the default from customer-pay to warranty-pay.
  let payType = parsed.data.payType;
  if (!payType) {
    if (parsed.data.type === "warranty" || parsed.data.type === "recall") {
      payType = "warranty";
    } else if (bookingCustomerId != null) {
      const today = zonedDayKey(
        new Date(),
        await dealerTimezone(createDealerId),
      );
      const [plan] = await db
        .select({ id: coveragePlansTable.id })
        .from(coveragePlansTable)
        .where(
          and(
            eq(coveragePlansTable.dealerId, createDealerId),
            eq(coveragePlansTable.customerId, bookingCustomerId),
            sql`${coveragePlansTable.startDate} <= ${today}`,
            sql`${coveragePlansTable.endDate} >= ${today}`,
          ),
        )
        .limit(1);
      payType = plan ? "warranty" : "customer";
    } else {
      payType = "customer";
    }
  }

  // Assignment + insert run in one transaction under a per-dealer/date
  // advisory lock so concurrent bookings can't both grab a technician's last
  // free hours and overbook the day.
  const order = await db.transaction(async (tx) => {
    if (autoAssign) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`svc-assign-${createDealerId}-${scheduledDateStr}`}))`,
      );
      const pick = await pickTechnicianRoundRobin(
        createDealerId,
        scheduledDateStr,
        estimatedHours,
        settings.techWorkHoursPerDay,
        tx,
      );
      if (pick) {
        technicianUserId = pick.id;
        technicianName = pick.name;
        if (pick.overCapacity) {
          assignmentNote = `All technicians are fully booked on ${scheduledDateStr} — assigned to ${pick.name} over capacity (FIFO).`;
        }
      } else {
        assignmentNote = `No technicians are set up for this dealership — booking left unassigned.`;
      }
    }
    const [row] = await tx
      .insert(serviceOrdersTable)
      .values({
        ...orderInput,
        customerPhoneSnapshot,
        customerId: bookingCustomerId,
        payType,
        technician: technicianName,
        technicianUserId,
        estimatedHours,
        dealerId: createDealerId,
        scheduledDate: scheduledDateStr,
        createdByUserId: res.locals.user?.id ?? null,
        createdByName:
          res.locals.user?.name ?? res.locals.user?.email ?? "System",
        createdOrigin: res.locals.user?.id != null ? "staff" : "system",
      })
      .returning();
    if (row) await ensureInitialJobCard(tx, row);
    return row;
  });

  // Tell the auto-assigned technician a job landed on their day.
  if (order && technicianUserId != null && parsed.data.technicianUserId == null) {
    notifyUser({
      dealerId: createDealerId,
      userId: technicianUserId,
      type: "assignment",
      entityType: "service_order",
      entityId: order.id,
      title: `New service booking #${order.id} assigned to you`,
      body: `${order.vehicleInfo} — ${order.type}, ${estimatedHours}h on ${scheduledDateStr}.`,
    }).catch(() => {});
  }

  // FR-COM-01: branded booking confirmation (deduped per order).
  if (order && order.customerId != null) onServiceOrderBooked(order);

  // Note: when assignmentNote is set the order goes out unassigned; the
  // client detects technician == null and surfaces the capacity warning.
  const effectiveEmail = await customerEmail(order.customerId, createDealerId);
  res.status(201).json(
    CreateServiceOrderResponse.parse({ ...order, customerEmail: effectiveEmail.email }),
  );
});

router.patch("/service-orders/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Normalize human-entered identity fields before generated min/max checks:
  // names/vehicle labels reject whitespace-only values, while a blank phone
  // deliberately clears the optional snapshot.
  const normalizedBody = { ...(req.body ?? {}) };
  if (typeof normalizedBody.vehicleInfo === "string") {
    normalizedBody.vehicleInfo = normalizedBody.vehicleInfo.trim();
  }
  for (const field of [
    "customerName",
    "vin",
    "registrationNumber",
    "technician",
    "complaint",
    "customerEmail",
  ] as const) {
    if (typeof normalizedBody[field] === "string") {
      normalizedBody[field] = normalizedBody[field].trim() || null;
    }
  }
  if (typeof normalizedBody.customerPhoneSnapshot === "string") {
    normalizedBody.customerPhoneSnapshot =
      normalizedBody.customerPhoneSnapshot.trim() || null;
  }
  if (typeof normalizedBody.brand === "string") {
    normalizedBody.brand = canonicalServiceBrand(normalizedBody.brand) || null;
  }
  const parsed = UpdateServiceOrderBody.safeParse(normalizedBody);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    scheduledDate,
    customerEmail: requestedEmail,
    estimatedCost: requestedEstimatedCost,
    estimatedHours: requestedEstimatedHours,
    ...rest
  } = parsed.data;
  const dateStr = toDateString(scheduledDate);

  const dealerId = activeDealerId(res);
  const [before] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    );

  if (!before || !technicianOwnsOrder(res, before)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

  // Keep the technician user ID in sync when only the display name is sent.
  // Clear the ID explicitly when the new name doesn't resolve, so a stale ID
  // from the previous technician never survives a rename.
  const updateValues: Partial<typeof serviceOrdersTable.$inferInsert> = {
    ...rest,
  };
  if (before.vehicleId != null && rest.brand !== undefined) {
    const [linkedVehicle] = await db
      .select({ make: vehiclesTable.make })
      .from(vehiclesTable)
      .where(and(
        eq(vehiclesTable.id, before.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
        isNull(vehiclesTable.deletedAt),
      ))
      .limit(1);
    if (!linkedVehicle) {
      res.status(404).json({ error: "Linked vehicle not found" });
      return;
    }
    updateValues.brand = canonicalServiceBrand(linkedVehicle.make);
  }
  if (requestedEstimatedCost !== undefined) {
    updateValues.estimatedCost = requestedEstimatedCost ?? 0;
  }
  if (requestedEstimatedHours !== undefined) {
    updateValues.estimatedHours =
      requestedEstimatedHours ?? (await getServiceSettings(dealerId)).defaultJobHours;
  }
  if (
    rest.customerPhoneSnapshot != null &&
    !validPhone(rest.customerPhoneSnapshot)
  ) {
    res.status(422).json({
      error: "Customer phone must contain 7–15 digits and sensible phone punctuation only",
    });
    return;
  }
  if (rest.customerId != null) {
    const [selectedCustomer] = await db
      .select({
        name: customersTable.name,
        phone: customersTable.phone,
      })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, rest.customerId),
          eq(customersTable.dealerId, dealerId),
          isNull(customersTable.deletedAt),
          isNull(customersTable.erasedAt),
        ),
      );
    if (!selectedCustomer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    if (rest.customerName === undefined) {
      updateValues.customerName = selectedCustomer.name;
    }
    if (rest.customerPhoneSnapshot === undefined) {
      const selectedPhone = selectedCustomer.phone?.trim() || null;
      updateValues.customerPhoneSnapshot = selectedPhone;
    }
  }
  if (rest.technician !== undefined && rest.technicianUserId === undefined) {
    updateValues.technicianUserId =
      rest.technician == null
        ? null
        : await resolveDealerUserIdByName(dealerId, rest.technician);
  }

  // customerEmail is an effective customer contact, not a separate booking
  // snapshot. Persist it on the linked customer so the edit form, reminder
  // button, and every server-side email trigger resolve the same address.
  let bookingCustomerId = rest.customerId !== undefined ? rest.customerId : before.customerId;
  if (requestedEmail !== undefined && requestedEmail != null && bookingCustomerId == null) {
    const [existingCustomer] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.dealerId, dealerId),
          sql`lower(${customersTable.email}) = ${requestedEmail.toLowerCase()}`,
          isNull(customersTable.deletedAt),
          isNull(customersTable.erasedAt),
        ),
      )
      .limit(1);
    if (existingCustomer) {
      bookingCustomerId = existingCustomer.id;
    } else {
      const [created] = await db
        .insert(customersTable)
        .values({
          dealerId,
          name: rest.customerName?.trim() || before.customerName?.trim() || requestedEmail,
          email: requestedEmail,
        })
        .returning({ id: customersTable.id });
      bookingCustomerId = created?.id ?? null;
    }
    updateValues.customerId = bookingCustomerId;
  }
  if (requestedEmail !== undefined && bookingCustomerId != null) {
    const [updatedCustomer] = await db
      .update(customersTable)
      .set({ email: requestedEmail, updatedAt: new Date() })
      .where(
        and(
          eq(customersTable.id, bookingCustomerId),
          eq(customersTable.dealerId, dealerId),
          isNull(customersTable.deletedAt),
          isNull(customersTable.erasedAt),
        ),
      )
      .returning({ id: customersTable.id });
    if (updatedCustomer) queueCustomerSync(dealerId, updatedCustomer.id);
  }
  if (dateStr) updateValues.scheduledDate = dateStr;

  const [order] = await db
    .update(serviceOrdersTable)
    .set(updateValues)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    )
    .returning();

  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

  if (before && dateStr && dateStr !== before.scheduledDate) {
    const [currentCard] = await db
      .select({ id: jobCardsTable.id, scheduledAt: jobCardsTable.scheduledAt })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.serviceOrderId, order.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (currentCard?.scheduledAt) {
      const hhmmss = currentCard.scheduledAt.toISOString().slice(11, 19);
      await db
        .update(jobCardsTable)
        .set({ scheduledAt: new Date(`${dateStr}T${hhmmss}Z`) })
        .where(
          and(
            eq(jobCardsTable.id, currentCard.id),
            eq(jobCardsTable.dealerId, dealerId),
          ),
        );
    }
  }

  if (before) onServiceOrderStatusChanged(before, order);
  if (
    before &&
    order.status === "acknowledged" &&
    (before.scheduledDate !== order.scheduledDate ||
      before.technicianUserId !== order.technicianUserId)
  ) {
    onServiceAppointmentChanged(order);
  }
  const effectiveEmail = await customerEmail(order.customerId, dealerId);
  res.json(
    UpdateServiceOrderResponse.parse({ ...order, customerEmail: effectiveEmail.email }),
  );
});

/** Technicians may only touch orders assigned to them (404, not 403, to avoid leaking existence). */
function technicianOwnsOrder(
  res: { locals: { user?: { id: number; roleName?: string | null; isSuperAdmin?: boolean } | null } },
  order: { technicianUserId: number | null },
): boolean {
  const viewer = res.locals.user;
  if (!isTechnicianRole(viewer)) return true;
  return order.technicianUserId === viewer!.id;
}

const ClaimServiceOrderParams = z.object({ id: z.coerce.number().int().positive() });
const ClaimServiceOrderBody = z.object({ technicianUserId: z.number().int().positive().optional() });

router.post("/service-orders/:id/claim", async (req, res): Promise<void> => {
  const params = ClaimServiceOrderParams.safeParse(req.params);
  const body = ClaimServiceOrderBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid assignment request" }); return;
  }
  const dealerId = activeDealerId(res);
  const actor = res.locals.user;
  if (!actor?.id) { res.status(401).json({ error: "Authentication required" }); return; }
  const [order] = await db.select().from(serviceOrdersTable).where(and(
    eq(serviceOrdersTable.id, params.data.id), eq(serviceOrdersTable.dealerId, dealerId),
  ));
  if (!order) { res.status(404).json({ error: "Service order not found" }); return; }
  if (order.technicianUserId != null) {
    res.status(409).json({ error: "Service order is already assigned" }); return;
  }
  const targetId = body.data.technicianUserId ?? actor.id;
  if (isTechnicianRole(actor) && targetId !== actor.id) {
    res.status(403).json({ error: "Technicians may claim work only for themselves" }); return;
  }
  if (!isTechnicianRole(actor) && !isServiceApprover(actor)) {
    res.status(403).json({ error: "Only technicians or service approvers may claim work" }); return;
  }
  const [target] = await db.select({
    id: usersTable.id, name: usersTable.name, email: usersTable.email,
    roleName: rolesTable.name, isGeneralManager: dealerUsersTable.isGeneralManager,
  }).from(dealerUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
    .innerJoin(rolesTable, eq(rolesTable.id, dealerUsersTable.roleId))
    .where(and(eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, targetId), eq(usersTable.status, "active")));
  if (!target || (targetId !== actor.id && !/technician/i.test(target.roleName))) {
    res.status(422).json({ error: "Selected technician is not eligible at this dealership" }); return;
  }
  const displayName = target.name ?? target.email ?? `User #${target.id}`;
  try {
    const assigned = await db.transaction(async (tx) => {
      // A service order is a work package: claim every still-open, unassigned
      // card on it in the same transaction. The response exposes the lowest-id
      // card as a stable representative and the count for callers that render
      // a package rather than an individual card.
      const cards = await tx.update(jobCardsTable).set({
        technicianUserId: target.id, technicianName: displayName,
      }).where(and(
        eq(jobCardsTable.serviceOrderId, order.id), eq(jobCardsTable.dealerId, dealerId),
        eq(jobCardsTable.status, "open"), isNull(jobCardsTable.technicianUserId),
      )).returning();
      if (cards.length === 0) throw new Error("assignment_conflict");
      const [claimedOrder] = await tx.update(serviceOrdersTable).set({
        technicianUserId: target.id, technician: displayName,
      }).where(and(
        eq(serviceOrdersTable.id, order.id), eq(serviceOrdersTable.dealerId, dealerId),
        isNull(serviceOrdersTable.technicianUserId),
      )).returning();
      if (!claimedOrder) throw new Error("assignment_conflict");
      await tx.insert(timelineEventsTable).values({
        dealerId, customerId: order.customerId, domain: "service", kind: "service_assignment_claimed",
        title: `Service order #${order.id} assigned to ${displayName}`,
        actor: actor.name ?? actor.email ?? "Staff", isAgent: false,
        refType: "service_order", refId: order.id,
      });
      const jobCard = cards.sort((a, b) => a.id - b.id)[0]!;
      return { serviceOrder: claimedOrder, jobCard, assignedJobCardCount: cards.length };
    });
    void notifyUser({ userId: target.id, dealerId, type: "assignment",
      title: `Job card #${assigned.jobCard.id} assigned to you`,
      body: `${assigned.jobCard.title} — ${assigned.serviceOrder.vehicleInfo}`, link: "/workshop" });
    res.json(assigned);
  } catch (error) {
    if (error instanceof Error && error.message === "assignment_conflict") {
      res.status(409).json({ error: "Service order or open job card is already assigned" }); return;
    }
    throw error;
  }
});

router.post("/service-orders/:id/remind", async (req, res): Promise<void> => {
  const params = SendServiceReminderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  if (!technicianOwnsOrder(res, order)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  const contact = await customerEmail(order.customerId, order.dealerId);

  // Existing unconfirmed bookings retain the email reminder behavior.  The
  // approved confirmation template is deliberately reachable only from the
  // acknowledged path below.
  if (order.status !== "acknowledged") {
    const recipient = effectiveServiceReminderRecipient(contact.email);
    if (!recipient) {
      res.status(422).json({ error: "Customer has no email on file" });
      return;
    }
    await enqueueEmail({
      template: "service_reminder",
      to: recipient,
      dealerId: order.dealerId,
      customerId: order.customerId,
      data: {
        vehicle: order.vehicleInfo,
        service: order.type,
        date: order.scheduledDate,
      },
    });
    res.json(
      SendServiceReminderResponse.parse({ status: "queued", recipient }),
    );
    return;
  }

  const recipient = normalizeWhatsappPhone(
    order.customerPhoneSnapshot || contact.phone || "",
  );
  if (!recipient) {
    res.status(422).json({ error: "Customer has no WhatsApp phone on file" });
    return;
  }
  const templateReadinessError = await serviceAppointmentTemplateReadinessError(
    order.dealerId,
  );
  if (templateReadinessError) {
    res.status(422).json({ error: templateReadinessError });
    return;
  }

  const [card] = await db
    .select({ scheduledAt: jobCardsTable.scheduledAt })
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.serviceOrderId, order.id),
        eq(jobCardsTable.dealerId, order.dealerId),
      ),
    )
    .limit(1);
  if (!card?.scheduledAt) {
    res.status(422).json({
      error: "This confirmed booking has no appointment schedule",
    });
    return;
  }

  const [dealer] = await db
    .select({ name: dealersTable.name })
    .from(dealersTable)
    .where(eq(dealersTable.id, order.dealerId))
    .limit(1);
  const timezone = await dealerTimezone(order.dealerId);
  const customerName = order.customerName?.trim() || contact.name?.trim();
  const dealershipName = dealer?.name?.trim();
  if (!customerName || !dealershipName) {
    res.status(422).json({
      error: "Customer and dealership names are required for the WhatsApp template",
    });
    return;
  }
  const bodyParameters = [
    customerName,
    dealershipName,
    `RO-${String(order.id).padStart(5, "0")}`,
    order.type,
    formatDealerDate(card.scheduledAt, timezone),
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(card.scheduledAt),
    order.vehicleInfo,
    order.registrationNumber?.trim() || "Not recorded",
  ] as const;
  const body = renderServiceAppointmentConfirmedBody(bodyParameters);
  const outbox = await enqueueWhatsapp({
    kind: "service.appointment.confirmed",
    to: recipient,
    dealerId: order.dealerId,
    customerId: order.customerId,
    summary: "Service Appointment Confirmed",
    body,
    dedupeKey: `svc:${order.id}:appointment-confirmed:${card.scheduledAt.getTime()}`,
    approvedTemplate: {
      name: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
      language: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
      bodyParameters,
    },
    context: {
      serviceOrderId: String(order.id),
      appointmentScheduledAt: card.scheduledAt.toISOString(),
    },
  });
  const disposition = whatsappOutboxDisposition(outbox);
  if (disposition === "blocked") {
    res.status(422).json({
      error:
        outbox.lastError ||
        "WhatsApp reminder was blocked by communication policy",
    });
    return;
  }
  res.json(
    SendServiceReminderResponse.parse({
      status: disposition === "already_sent" ? "sent" : "queued",
      recipient,
    }),
  );
});

router.get(
  "/service-orders/:id/appointment-confirmation",
  async (req, res): Promise<void> => {
    const params = ConfirmServiceAppointmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    const [order] = await db
      .select({
        id: serviceOrdersTable.id,
        technicianUserId: serviceOrdersTable.technicianUserId,
      })
      .from(serviceOrdersTable)
      .where(
        and(
          eq(serviceOrdersTable.id, params.data.id),
          eq(serviceOrdersTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (!order || !technicianOwnsOrder(res, order)) {
      res.status(404).json({ error: "Service order not found" });
      return;
    }
    const [card] = await db
      .select({ scheduledAt: jobCardsTable.scheduledAt })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.serviceOrderId, order.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (!card?.scheduledAt) {
      res.json(
        GetServiceAppointmentConfirmationDeliveryResponse.parse(
          serviceAppointmentConfirmationDelivery(undefined),
        ),
      );
      return;
    }
    const [row] = await db
      .select({
        status: emailLogsTable.status,
        deliveryStatus: emailLogsTable.deliveryStatus,
        recipient: emailLogsTable.recipient,
        attempts: emailLogsTable.attempts,
        lastError: emailLogsTable.lastError,
        providerMessageId: emailLogsTable.providerMessageId,
        sentAt: emailLogsTable.sentAt,
        deliveredAt: emailLogsTable.deliveredAt,
        readAt: emailLogsTable.readAt,
        payload: emailLogsTable.payload,
      })
      .from(emailLogsTable)
      .where(
        and(
          eq(emailLogsTable.dealerId, dealerId),
          eq(emailLogsTable.channel, "whatsapp"),
          eq(emailLogsTable.template, "service.appointment.confirmed"),
          eq(
            emailLogsTable.dedupeKey,
            `svc:${order.id}:appointment-confirmed:${card.scheduledAt.getTime()}`,
          ),
        ),
      )
      .orderBy(desc(emailLogsTable.id))
      .limit(1);
    res.json(
      GetServiceAppointmentConfirmationDeliveryResponse.parse(
        serviceAppointmentConfirmationDelivery(row),
      ),
    );
  },
);

router.post(
  "/service-orders/:id/appointment-confirmation/retry",
  async (req, res): Promise<void> => {
    const params = ConfirmServiceAppointmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    const [order] = await db
      .select()
      .from(serviceOrdersTable)
      .where(
        and(
          eq(serviceOrdersTable.id, params.data.id),
          eq(serviceOrdersTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (!order || !technicianOwnsOrder(res, order)) {
      res.status(404).json({ error: "Service order not found" });
      return;
    }
    const [card] = await db
      .select({ scheduledAt: jobCardsTable.scheduledAt })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.serviceOrderId, order.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (order.status !== "acknowledged" || !card?.scheduledAt) {
      res.status(409).json({
        error:
          "This appointment confirmation cannot be retried because the booking or schedule changed.",
      });
      return;
    }
    const contact = await customerEmail(order.customerId, dealerId);
    const recipient = normalizeWhatsappPhone(
      order.customerPhoneSnapshot || contact.phone || "",
    );
    if (!recipient) {
      res.status(422).json({ error: "Customer has no WhatsApp phone on file" });
      return;
    }
    if (
      contact.phone &&
      normalizeWhatsappPhone(contact.phone) !== recipient
    ) {
      res.status(409).json({
        error:
          "The customer WhatsApp number changed after this confirmation failed. Review the appointment before sending a new confirmation.",
      });
      return;
    }
    const templateReadinessError =
      await serviceAppointmentTemplateReadinessError(dealerId);
    if (templateReadinessError) {
      res.status(422).json({ error: templateReadinessError });
      return;
    }
    const policyError = await whatsappRetryPolicyError({
      dealerId,
      recipient,
      customerId: order.customerId,
      kind: "service.appointment.confirmed",
    });
    if (policyError) {
      res.status(422).json({ error: policyError });
      return;
    }
    const dedupeKey = `svc:${order.id}:appointment-confirmed:${card.scheduledAt.getTime()}`;
    const [existing] = await db
      .select({
        id: emailLogsTable.id,
        recipient: emailLogsTable.recipient,
        payload: emailLogsTable.payload,
      })
      .from(emailLogsTable)
      .where(
        and(
          eq(emailLogsTable.dealerId, dealerId),
          eq(emailLogsTable.dedupeKey, dedupeKey),
          eq(emailLogsTable.channel, "whatsapp"),
          eq(emailLogsTable.template, "service.appointment.confirmed"),
        ),
      )
      .limit(1);
    if (
      !existing ||
      existing.recipient !== recipient ||
      existing.payload?.serviceOrderId !== String(order.id) ||
      existing.payload?.appointmentScheduledAt !== card.scheduledAt.toISOString() ||
      !hasValidServiceAppointmentTemplatePayload(existing.payload)
    ) {
      res.status(409).json({
        error:
          "The stored confirmation no longer matches this appointment and cannot be retried.",
      });
      return;
    }
    const retried = await retryRejectedWhatsappOutboxItem({
      id: existing.id,
      dealerId,
    });
    if (!retried) {
      res.status(409).json({
        error:
          "Only a definitively rejected confirmation without a provider message ID can be retried.",
      });
      return;
    }
    res.json(
      GetServiceAppointmentConfirmationDeliveryResponse.parse(
        serviceAppointmentConfirmationDelivery(retried),
      ),
    );
  },
);

router.post("/service-orders/:id/confirm", async (req, res): Promise<void> => {
  const params = ConfirmServiceAppointmentParams.safeParse(req.params);
  const body = ConfirmServiceAppointmentBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    );
  if (!order || !technicianOwnsOrder(res, order)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  if (!["open", "acknowledged"].includes(order.status)) {
    res.status(409).json({ error: "This booking is no longer awaiting confirmation" });
    return;
  }
  const timezone = await dealerTimezone(dealerId);
  const scheduledDate = toDateString(body.data.date);
  const dateParts = scheduledDate?.split("-").map(Number);
  const timeParts = body.data.time.split(":").map(Number);
  if (!scheduledDate || dateParts?.length !== 3 || timeParts.length !== 2) {
    res.status(422).json({ error: "Choose a valid appointment date and time" });
    return;
  }
  const scheduledAt = zonedTimeToUtc(
    timezone,
    dateParts[0]!,
    dateParts[1]!,
    dateParts[2]!,
    timeParts[0]!,
    timeParts[1]!,
  );

  const [appointment] = await db
    .select({ id: jobCardsTable.id })
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.serviceOrderId, order.id),
        eq(jobCardsTable.dealerId, dealerId),
      ),
    )
    .limit(1);
  if (!appointment) {
    res.status(422).json({ error: "This booking has no job card to schedule" });
    return;
  }

  const confirmed = await db.transaction(async (tx) => {
    await tx
      .update(jobCardsTable)
      .set({ scheduledAt })
      .where(
        and(
          eq(jobCardsTable.serviceOrderId, order.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      );
    if (order.status === "acknowledged") {
      const [updated] = await tx
        .update(serviceOrdersTable)
        .set({ scheduledDate })
        .where(
          and(
            eq(serviceOrdersTable.id, order.id),
            eq(serviceOrdersTable.dealerId, dealerId),
            eq(serviceOrdersTable.status, "acknowledged"),
          ),
        )
        .returning();
      return updated ?? null;
    }
    const stageEvent = {
      from: "open",
      to: "acknowledged",
      justification: "Service appointment confirmed with customer",
      byUserId: res.locals.user?.id ?? null,
      byName: res.locals.user?.name ?? res.locals.user?.email ?? "Unknown",
      at: new Date().toISOString(),
    };
    const [updated] = await tx
      .update(serviceOrdersTable)
      .set({
        status: "acknowledged",
        scheduledDate,
        stageHistory: sql`coalesce(${serviceOrdersTable.stageHistory}, '[]'::jsonb) || ${JSON.stringify([stageEvent])}::jsonb`,
      })
      .where(
        and(
          eq(serviceOrdersTable.id, order.id),
          eq(serviceOrdersTable.dealerId, dealerId),
          eq(serviceOrdersTable.status, "open"),
        ),
      )
      .returning();
    return updated ?? null;
  });
  if (!confirmed) {
    res.status(409).json({ error: "Booking status changed; refresh and try again" });
    return;
  }

  res.json(
    ConfirmServiceAppointmentResponse.parse({
      status: "confirmed",
      recipient: null,
    }),
  );
});

router.get("/service-orders/:id/onboarding-media", async (req, res): Promise<void> => {
  const params = ListServiceOrderOnboardingMediaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [order] = await db
    .select({ id: serviceOrdersTable.id, technicianUserId: serviceOrdersTable.technicianUserId })
    .from(serviceOrdersTable)
    .where(and(eq(serviceOrdersTable.id, params.data.id), eq(serviceOrdersTable.dealerId, dealerId)));
  if (!order || !technicianOwnsOrder(res, order)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  const rows = await db
    .select({
      id: vehicleOnboardingMediaTable.id,
      kind: vehicleOnboardingMediaTable.kind,
      mimeType: vehicleOnboardingMediaTable.mimeType,
      sizeBytes: vehicleOnboardingMediaTable.sizeBytes,
      originalName: vehicleOnboardingMediaTable.originalName,
      createdAt: vehicleOnboardingMediaTable.createdAt,
    })
    .from(vehicleOnboardingMediaTable)
    .innerJoin(
      vehicleOnboardingRequestsTable,
      and(
        eq(vehicleOnboardingRequestsTable.id, vehicleOnboardingMediaTable.requestId),
        eq(vehicleOnboardingRequestsTable.dealerId, dealerId),
        eq(vehicleOnboardingRequestsTable.serviceOrderId, order.id),
      ),
    )
    .where(
      and(
        eq(vehicleOnboardingMediaTable.dealerId, dealerId),
        sql`${vehicleOnboardingMediaTable.finalizedAt} is not null`,
      ),
    )
    .orderBy(vehicleOnboardingMediaTable.createdAt);
  res.json(
    ListServiceOrderOnboardingMediaResponse.parse(
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        fileName: row.originalName || `${row.kind}-${row.id}`,
        createdAt: row.createdAt,
      })),
    ),
  );
});

router.get("/service-orders/:id/onboarding-media/:mediaId", async (req, res): Promise<void> => {
  const params = ReadServiceOrderOnboardingMediaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [media] = await db
    .select({
      objectPath: vehicleOnboardingMediaTable.objectPath,
      mimeType: vehicleOnboardingMediaTable.mimeType,
      sizeBytes: vehicleOnboardingMediaTable.sizeBytes,
      technicianUserId: serviceOrdersTable.technicianUserId,
    })
    .from(vehicleOnboardingMediaTable)
    .innerJoin(
      vehicleOnboardingRequestsTable,
      and(
        eq(vehicleOnboardingRequestsTable.id, vehicleOnboardingMediaTable.requestId),
        eq(vehicleOnboardingRequestsTable.dealerId, dealerId),
        eq(vehicleOnboardingRequestsTable.serviceOrderId, params.data.id),
      ),
    )
    .innerJoin(
      serviceOrdersTable,
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    )
    .where(
      and(
        eq(vehicleOnboardingMediaTable.id, params.data.mediaId),
        eq(vehicleOnboardingMediaTable.dealerId, dealerId),
        sql`${vehicleOnboardingMediaTable.finalizedAt} is not null`,
      ),
    );
  if (!media || !technicianOwnsOrder(res, media)) {
    res.status(404).json({ error: "Onboarding media not found" });
    return;
  }
  try {
    const file = await objectStorage.getObjectEntityFile(media.objectPath);
    res.setHeader("Content-Type", media.mimeType);
    res.setHeader("Content-Length", String(media.sizeBytes));
    res.setHeader("Cache-Control", "private, no-store");
    file.createReadStream().on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Onboarding media not found" });
      return;
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Service case advance (adjacent-only NC-3 machine + manager review gate)
// ---------------------------------------------------------------------------

/** Adjacent-only transitions for the 7-status service case machine. */
const SERVICE_ADVANCE_MAP: Record<string, string[]> = {
  open: ["acknowledged", "cancelled"],
  acknowledged: ["in_progress", "cancelled"],
  in_progress: ["on_hold", "resolved", "cancelled"],
  on_hold: ["in_progress", "cancelled"],
  resolved: ["closed"],
  closed: [],
  cancelled: [],
};

/** Pay types whose closure needs an approved manager gate (money the dealer eats). */
const GATED_PAY_TYPES = new Set(["warranty", "goodwill", "rectify"]);

router.post("/service-orders/:id/advance", async (req, res): Promise<void> => {
  const params = AdvanceServiceOrderParams.safeParse(req.params);
  const parsed = AdvanceServiceOrderBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    );
  if (!order || !technicianOwnsOrder(res, order)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  const target = parsed.data.targetStatus;
  if (!(SERVICE_ADVANCE_MAP[order.status] ?? []).includes(target)) {
    res.status(422).json({
      unmet: [
        `Cannot move a ${order.status} case to ${target} — transitions are one step at a time`,
      ],
    });
    return;
  }

  const unmet: string[] = [];

  if (target === "resolved") {
    // All active work must be finished before the case can resolve.
    const cards = await db
      .select({ id: jobCardsTable.id, status: jobCardsTable.status })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.serviceOrderId, order.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      );
    const unfinished = cards.filter(
      (c) => !["completed", "closed", "cancelled"].includes(c.status),
    );
    if (unfinished.length > 0) {
      unmet.push(
        `${unfinished.length} job card(s) still open — complete or cancel them first`,
      );
    }
  }

  if (target === "closed") {
    // Customer-pay work needs an issued invoice before pickup.
    if (order.payType === "customer") {
      const [invoice] = await db
        .select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(
          and(
            eq(serviceInvoicesTable.serviceOrderId, order.id),
            eq(serviceInvoicesTable.dealerId, dealerId),
          ),
        )
        .limit(1);
      if (!invoice) unmet.push("No service invoice issued for this case yet");
    }
    // Collision repairs cannot close around the claim: the claim must have
    // completed insurer sign-off + invoicing (or exited as denied/total-loss)
    // before the repair order itself closes (Task 279).
    const [claim] = await db
      .select({
        id: collisionClaimsTable.id,
        status: collisionClaimsTable.status,
      })
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.serviceOrderId, order.id),
          eq(collisionClaimsTable.dealerId, dealerId),
        ),
      );
    if (
      claim &&
      !["invoiced", "closed", "denied", "total_loss"].includes(claim.status)
    ) {
      unmet.push(
        `Collision claim #${claim.id} is still ${claim.status.replace(/_/g, " ")} — it needs insurer sign-off and invoicing (or a denied/total-loss outcome) first`,
      );
    }
    // Recall work and dealer-funded pay types need explicit manager approval
    // before the case closes (mirrors the pipeline stage_advance gate).
    if (GATED_PAY_TYPES.has(order.payType) || order.type === "recall") {
      const [gate] = await db
        .select()
        .from(gatesTable)
        .where(
          and(
            eq(gatesTable.dealerId, dealerId),
            eq(gatesTable.type, "stage_advance"),
            eq(gatesTable.refType, "service_order"),
            eq(gatesTable.refId, order.id),
          ),
        )
        .orderBy(desc(gatesTable.createdAt))
        .limit(1);
      if (!gate || gate.status === "dismissed") {
        await db.insert(gatesTable).values({
          dealerId,
          type: "stage_advance",
          status: "pending",
          priority: "normal",
          customerId: order.customerId ?? null,
          customerName: order.customerName ?? null,
          refType: "service_order",
          refId: order.id,
          title: `Close ${order.payType}-pay service case #${order.id}`,
          summary: `${order.vehicleInfo} — ${order.type} case funded as ${order.payType}. Manager sign-off required before closing.`,
          evidence: [
            { label: "Pay type", value: order.payType },
            { label: "Case type", value: order.type },
          ],
        });
        unmet.push("Manager approval requested — pending review");
      } else if (gate.status === "pending") {
        unmet.push("Manager approval pending review");
      }
    }
  }

  if (unmet.length > 0) {
    res.status(422).json({ unmet });
    return;
  }

  // Every stage transition carries a mandatory justification (audit trail).
  const stageEvent = {
    from: order.status,
    to: target,
    justification: parsed.data.justification.trim(),
    byUserId: res.locals.user?.id ?? null,
    byName: res.locals.user?.name ?? res.locals.user?.email ?? "Unknown",
    at: new Date().toISOString(),
  };

  const [before] = [order];
  const [updated] = await db.transaction(async tx => {
    if (target === "cancelled") {
      const cards = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.serviceOrderId, order.id), eq(jobCardsTable.dealerId, dealerId),
      )).orderBy(jobCardsTable.id).for("update");
      for (const card of cards) {
        await releaseJobPartHolds(tx, dealerId, card.id);
        if (!["completed", "closed"].includes(card.status)) await tx.update(jobCardsTable)
          .set({ status: "cancelled", timerStartedAt: null }).where(and(
            eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId),
          ));
      }
    }
    return tx
    .update(serviceOrdersTable)
    .set({
      status: target,
      stageHistory: sql`coalesce(${serviceOrdersTable.stageHistory}, '[]'::jsonb) || ${JSON.stringify([stageEvent])}::jsonb`,
    })
    .where(
      and(
        eq(serviceOrdersTable.id, order.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    )
    .returning();
  });

  if (updated && before) onServiceOrderStatusChanged(before, updated);

  // Closing the case writes the pickup into the customer's service history.
  if (updated && target === "closed" && updated.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: updated.customerId,
      domain: "service",
      kind: "service_case_closed",
      title: `Service case #${updated.id} closed — vehicle picked up`,
      detail: `${updated.vehicleInfo} — ${updated.type} (${updated.payType}-pay) completed.`,
      actor: res.locals.user?.name ?? "Service",
      isAgent: false,
      cause: `Service order #${updated.id}`,
      refType: "service_order",
      refId: updated.id,
    });
  }

  res.json(AdvanceServiceOrderResponse.parse(updated));
});

router.delete("/service-orders/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    );
  if (!order || !technicianOwnsOrder(res, order)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

  // Invoiced work is a financial record — it can't be deleted from here.
  const [invoice] = await db
    .select({ id: serviceInvoicesTable.id })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.dealerId, dealerId),
        eq(serviceInvoicesTable.serviceOrderId, order.id),
      ),
    )
    .limit(1);
  if (invoice) {
    res.status(409).json({
      error:
        "order_invoiced: this booking has an issued invoice — void the invoice first",
    });
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    const cards = await tx
      .select({ id: jobCardsTable.id })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.dealerId, dealerId),
          eq(jobCardsTable.serviceOrderId, order.id),
        ),
      ).orderBy(jobCardsTable.id).for("update");
    const [lockedInvoice] = await tx.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable).where(and(
      eq(serviceInvoicesTable.dealerId, dealerId), eq(serviceInvoicesTable.serviceOrderId, order.id),
    ));
    if (lockedInvoice) throw Object.assign(new Error("Invoiced work cannot be deleted"), { status: 409 });
    for (const card of cards) {
      const lines = await tx.select().from(jobCardPartsTable).where(and(
        eq(jobCardPartsTable.jobCardId, card.id), eq(jobCardPartsTable.dealerId, dealerId),
      ));
      if (lines.some(line => issuedUnits(line) > 0 || line.kind === "return")) {
        throw Object.assign(new Error("Issued part history cannot be deleted; cancel the booking instead"), { status: 409 });
      }
      await releaseJobPartHolds(tx, dealerId, card.id);
    }
    // The FK below intentionally nulls the live card link. Backstop the
    // immutable association in this same delete transaction so a manual
    // correction continues to visibly supersede ledger evidence for a card
    // deleted through this supported route. Never overwrite an existing
    // historical value or infer one for an already-unlinked row.
    if (cards.length > 0) {
      await tx
        .update(technicianTimesheetEntriesTable)
        .set({
          originalJobCardId: sql`coalesce(${technicianTimesheetEntriesTable.originalJobCardId}, ${technicianTimesheetEntriesTable.jobCardId})`,
        })
        .where(
          and(
            eq(technicianTimesheetEntriesTable.dealerId, dealerId),
            inArray(
              technicianTimesheetEntriesTable.jobCardId,
              cards.map((card) => card.id),
            ),
          ),
        );
    }
    await tx
      .delete(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.dealerId, dealerId),
          eq(jobCardsTable.serviceOrderId, order.id),
        ),
      );
    // Keep the Message-ID ledger: deleting it would let the same email
    // recreate the booking. Detach only the optional booking reference.
    await tx
      .update(webhookEventsTable)
      .set({ serviceOrderId: null })
      .where(
        and(
          eq(webhookEventsTable.dealerId, dealerId),
          eq(webhookEventsTable.serviceOrderId, order.id),
        ),
      );
    await tx
      .delete(serviceOrdersTable)
      .where(eq(serviceOrdersTable.id, order.id));
    return true;
  }).catch(error => {
    const failure = error as Error & { status?: number };
    if (!failure.status) throw error;
    res.status(failure.status).json({ error: failure.message });
    return false;
  });
  if (!deleted) return;
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Technicians
// ---------------------------------------------------------------------------

router.get("/service-technicians", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, activeDealerId(res)),
        eq(rolesTable.name, "Technician"),
      ),
    );
  res.json(
    ListServiceTechniciansResponse.parse(
      rows.map((r) => ({ id: r.id, name: r.name ?? r.email ?? `User #${r.id}` })),
    ),
  );
});

// ---------------------------------------------------------------------------
// Job cards
// ---------------------------------------------------------------------------

/** Workshop contact snapshots come only from this dealer's linked customer. */
async function resolveCustomerPhoneSnapshot(
  customerId: number | null | undefined,
  dealerId: number,
): Promise<string | null> {
  if (customerId == null) return null;
  const [customer] = await db
    .select({ phone: customersTable.phone })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
      ),
    )
    .limit(1);
  const phone = customer?.phone?.trim();
  return phone && validPhone(phone) ? phone : null;
}

/** Permissive for international formatting, but rejects short/textual values. */
function validPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 && /^[+\d\s().-]+$/.test(value);
}

/** Whole seconds elapsed since `from` (never negative). */
function elapsedSeconds(from: Date): number {
  return Math.max(0, Math.round((Date.now() - from.getTime()) / 1000));
}

/** SQL fragment: accumulated timer seconds plus the running segment, folded
 * atomically from the row's CURRENT values (immune to read-then-write races). */
const foldedTimerSeconds = sql<number>`${jobCardsTable.timerSeconds} + coalesce(greatest(0, extract(epoch from (now() - ${jobCardsTable.timerStartedAt})))::int, 0)`;

/** Timer/reopen are edit-actions on an existing card: allowed for service
 * managers/management, or the technician the card is assigned to. */
function canActOnJobCard(
  user:
    | { id?: number; roleName?: string | null; isSuperAdmin?: boolean }
    | undefined
    | null,
  card: { technicianUserId: number | null },
): boolean {
  if (isServiceApprover(user)) return true;
  return card.technicianUserId != null && user?.id === card.technicianUserId;
}

// Service-history lookup: technicians search past job cards across ALL
// customers/vehicles (view permission on service is enforced by the router
// middleware). Newest first, capped at 100 rows.
router.get("/job-cards/history", async (req, res): Promise<void> => {
  const query = ListJobCardHistoryQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const q = query.data.q?.trim();
  const like = q ? `%${q}%` : null;
  const rows = await db
    .select({
      id: jobCardsTable.id,
      serviceOrderId: jobCardsTable.serviceOrderId,
      title: jobCardsTable.title,
      status: jobCardsTable.status,
      technicianName: jobCardsTable.technicianName,
      customerName: serviceOrdersTable.customerName,
      vehicleInfo: serviceOrdersTable.vehicleInfo,
      laborHours: jobCardsTable.laborHours,
      timerSeconds: jobCardsTable.timerSeconds,
      serviceAnalysis: jobCardsTable.serviceAnalysis,
      workPerformed: jobCardsTable.workPerformed,
      startedAt: jobCardsTable.startedAt,
      completedAt: jobCardsTable.completedAt,
      createdAt: jobCardsTable.createdAt,
    })
    .from(jobCardsTable)
    .innerJoin(
      serviceOrdersTable,
      and(
        eq(jobCardsTable.serviceOrderId, serviceOrdersTable.id),
        // Tenancy: constrain the joined table too, never trust the FK alone.
        eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId),
      ),
    )
    .where(
      and(
        eq(jobCardsTable.dealerId, activeDealerId(res)),
        like
          ? or(
              ilike(serviceOrdersTable.customerName, like),
              ilike(serviceOrdersTable.vehicleInfo, like),
              ilike(jobCardsTable.title, like),
            )
          : undefined,
      ),
    )
    .orderBy(desc(jobCardsTable.createdAt), desc(jobCardsTable.id));
  res.json(ListJobCardHistoryResponse.parse(rows));
});

// Current workshop WIP, calculated against the dealer's calendar day rather
// than browser/UTC midnight. A future booking is never WIP, even if its card
// was auto-created on an earlier day.
router.get("/job-cards/wip", async (req, res): Promise<void> => {
  const query = ListWorkshopWipQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const today = zonedDayKey(new Date(), await dealerTimezone(dealerId));
  const viewer = res.locals.user;
  const rows = await db
    .select({
      id: jobCardsTable.id,
      serviceOrderId: jobCardsTable.serviceOrderId,
      title: jobCardsTable.title,
      customerName: serviceOrdersTable.customerName,
      vehicleInfo: serviceOrdersTable.vehicleInfo,
      receivedAt: jobCardsTable.receivedAt,
      startedAt: jobCardsTable.startedAt,
      status: jobCardsTable.status,
      technicianUserId: jobCardsTable.technicianUserId,
      technicianName: jobCardsTable.technicianName,
      waitingReason: jobCardsTable.waitingReason,
      nextAction: jobCardsTable.nextAction,
      followUpDate: jobCardsTable.followUpDate,
    })
    .from(jobCardsTable)
    .innerJoin(serviceOrdersTable, and(
      eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
      eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId),
    ))
    .where(and(
      eq(jobCardsTable.dealerId, dealerId),
      inArray(jobCardsTable.status, [...ACTIVE_JOB_CARD_STATUSES]),
      // scheduledDate is the booking's business day; exclude future work.
      lte(serviceOrdersTable.scheduledDate, today),
      query.data.technicianUserId != null
        ? eq(jobCardsTable.technicianUserId, query.data.technicianUserId)
        : undefined,
      query.data.waitingReason
        ? eq(jobCardsTable.waitingReason, query.data.waitingReason)
        : undefined,
      isTechnicianRole(viewer)
        ? eq(jobCardsTable.technicianUserId, viewer!.id)
        : undefined,
    ))
    .orderBy(jobCardsTable.createdAt);
  const tz = await dealerTimezone(dealerId);
  const receivedRows = rows.filter(
    (row): row is typeof row & { receivedAt: Date | null; startedAt: Date } =>
      row.receivedAt != null || row.startedAt != null,
  );
  const output = receivedRows.map((row) => {
    const receivedAt = row.receivedAt ?? row.startedAt;
    const receivedDay = zonedDayKey(receivedAt, tz);
    const elapsedDays = Math.max(
      0,
      Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${receivedDay}T00:00:00Z`)) / 86_400_000),
    );
    return {
      ...row,
      receivedAt,
      receivedSource: row.receivedAt ? "intake" as const : "legacy_started" as const,
      elapsedDays,
      carryOver: receivedDay < today,
    };
  }).filter((row) =>
    (query.data.carryOver !== "1" || row.carryOver) &&
    (query.data.carryOver !== "0" || !row.carryOver) &&
    (query.data.followUp !== "overdue" || (row.followUpDate != null && row.followUpDate < today)) &&
    (query.data.followUp !== "today" || row.followUpDate === today) &&
    (query.data.followUp !== "upcoming" || (row.followUpDate != null && row.followUpDate > today)) &&
    (query.data.followUp !== "none" || row.followUpDate == null) &&
    (query.data.minAgeDays == null || row.elapsedDays >= query.data.minAgeDays!),
  );
  if (query.data.format) {
    const [dealer] = await db.select().from(dealersTable)
      .where(eq(dealersTable.id, dealerId));
    await renderReportExport(res, {
      type: "service_workshop_wip",
      label: "Service & Workshop — Live WIP",
      from: today,
      to: today,
      kpis: [
        { label: "Open WIP", value: String(output.length), sub: "Dealer-day scoped" },
        { label: "Carry-over", value: String(output.filter((row) => row.carryOver).length) },
        { label: "On hold", value: String(output.filter((row) => row.status === "on_hold").length) },
        { label: "Follow-ups due", value: String(output.filter((row) => row.followUpDate != null && row.followUpDate <= today).length) },
      ],
      chart: { kind: "bar", valueLabel: "Open jobs", points: [] },
      table: {
        columns: ["Job card", "Customer", "Vehicle", "Received / first known work", "Technician", "Status", "Waiting reason", "Next action", "Follow-up", "Age", "Carry-over"],
        rows: output.map((row) => [
          `JC #${row.id}`, row.customerName ?? "—", row.vehicleInfo,
          `${formatDealerDateTime(row.receivedAt, tz)}${row.receivedSource === "legacy_started" ? " (legacy work-start; intake unknown)" : ""}`,
          row.technicianName ?? "Unassigned", row.status,
          row.waitingReason ?? "—", row.nextAction ?? "—",
          row.followUpDate ?? "—", `${row.elapsedDays} d`,
          row.carryOver ? "Yes" : "No",
        ]),
      },
    }, query.data.format, {
      dealerName: dealer?.name ?? `Dealer ${dealerId}`,
      usdExchangeRate: dealer?.usdExchangeRate ?? 0,
      timezone: tz,
    });
    return;
  }
  res.json(ListWorkshopWipResponse.parse(output));
});

router.get("/job-cards", async (req, res): Promise<void> => {
  const query = ListJobCardsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const me = res.locals.user;
  const filters = [
    eq(jobCardsTable.dealerId, activeDealerId(res)),
    query.data.serviceOrderId !== undefined
      ? eq(jobCardsTable.serviceOrderId, query.data.serviceOrderId)
      : undefined,
    query.data.status !== undefined
      ? eq(jobCardsTable.status, query.data.status)
      : undefined,
    query.data.mine === "1" && me
      ? eq(jobCardsTable.technicianUserId, me.id)
      : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));

  const rows = await db
    .select({
      ...getTableColumns(jobCardsTable),
      customerName: serviceOrdersTable.customerName,
      vehicleInfo: serviceOrdersTable.vehicleInfo,
    })
    .from(jobCardsTable)
    .innerJoin(serviceOrdersTable, and(
      eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
      eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId),
    ))
    .where(and(
      ...filters,
      isTechnicianRole(me)
        ? or(
            eq(jobCardsTable.technicianUserId, me!.id),
            isNull(jobCardsTable.technicianUserId),
          )
        : undefined,
    ))
    .orderBy(desc(jobCardsTable.createdAt));
  res.json(ListJobCardsResponse.parse(rows));
});

router.get("/job-cards/:id", async (req, res): Promise<void> => {
  const params = GetJobCardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const viewer = res.locals.user;
  const [row] = await db
    .select({
      jobCard: jobCardsTable,
      serviceOrder: serviceOrdersTable,
    })
    .from(jobCardsTable)
    .innerJoin(
      serviceOrdersTable,
      and(
        eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
        eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId),
      ),
    )
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
        isTechnicianRole(viewer)
          ? or(
              eq(jobCardsTable.technicianUserId, viewer!.id),
              isNull(jobCardsTable.technicianUserId),
            )
          : undefined,
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const partTotals = await db.select({
    net: sql<number>`coalesce(sum(case when ${jobCardPartsTable.kind} = 'return' then -${jobCardPartsTable.quantity} * ${jobCardPartsTable.unitPrice} else ${jobCardPartsTable.quantity} * ${jobCardPartsTable.unitPrice} end), 0)`,
  }).from(jobCardPartsTable).where(and(
    eq(jobCardPartsTable.jobCardId, row.jobCard.id),
    eq(jobCardPartsTable.dealerId, row.jobCard.dealerId),
  ));
  const [latestEstimate] = await db.select({
    decision: serviceEstimateDecisionsTable.decision,
    invalidatedAt: serviceEstimateDecisionsTable.invalidatedAt,
    expiresAt: serviceEstimateDecisionsTable.expiresAt,
  }).from(serviceEstimateDecisionsTable).where(and(
    eq(serviceEstimateDecisionsTable.dealerId, row.jobCard.dealerId),
    eq(serviceEstimateDecisionsTable.jobCardId, row.jobCard.id),
    eq(serviceEstimateDecisionsTable.estimateVersion, row.jobCard.estimateVersion),
  )).orderBy(desc(serviceEstimateDecisionsTable.createdAt)).limit(1);
  const latestEstimateState =
    !latestEstimate ? "not_sent" :
    latestEstimate.invalidatedAt ? "stale" :
    latestEstimate.decision ?? (latestEstimate.expiresAt <= new Date() ? "expired" : "open");
  res.json(GetJobCardResponse.parse({
    ...row,
    jobCard: {
      ...row.jobCard,
      customerName: row.serviceOrder.customerName,
      vehicleInfo: row.serviceOrder.vehicleInfo,
      netPartsTotal: Number(partTotals[0]?.net ?? 0),
      latestEstimateState,
    },
  }));
});

router.post("/job-cards", async (req, res): Promise<void> => {
  const parsed = CreateJobCardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, parsed.data.serviceOrderId),
        eq(serviceOrdersTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  const surcharge = await computeLateSurcharge(order);
  const submittedPhone =
    typeof req.body?.customerPhoneSnapshot === "string"
      ? req.body.customerPhoneSnapshot.trim()
      : undefined;
  if (submittedPhone !== undefined && submittedPhone !== "" && !validPhone(submittedPhone)) {
    res.status(400).json({
      error: "Customer phone must contain 7–15 digits and sensible phone punctuation only",
    });
    return;
  }
  // An explicitly supplied job-card contact is a snapshot override, never a
  // customer-master update. Otherwise prefill from the dealer-scoped order's
  // snapshot or linked customer.
  const customerPhoneSnapshot =
    submittedPhone || (order as any).customerPhoneSnapshot || (await resolveCustomerPhoneSnapshot(order.customerId, order.dealerId));
  const payType = parsed.data.payType ?? order.payType;
  const laborHours = parsed.data.laborHours ?? order.estimatedHours ?? 0;
  const quotedLaborHours = parsed.data.quotedLaborHours ?? laborHours;
  const settings = await getServiceSettings(order.dealerId);
  const laborRate = resolveNewCardLabourRate(
    parsed.data.laborRate,
    settings.labourUsdToGydRate,
    labourUsdPerHourForBrand(order.brand, settings.brandLabourRates),
  );
  const quoteTotal = await initialJobCardQuoteTotal({
    dealerId: order.dealerId,
    quotedLaborHours,
    laborRate,
    ...surcharge,
  });
  let card: typeof jobCardsTable.$inferSelect | undefined;
  try {
    // Asset + pay type flow down from the case unless explicitly overridden.
    [card] = await db
      .insert(jobCardsTable)
      .values({
        ...parsed.data,
        ...surcharge,
        assetId: order.assetId ?? null,
        payType,
        laborHours,
        quotedLaborHours,
        laborRate,
        quoteTotal,
        status: "open",
        scheduledAt: parsed.data.scheduledAt
          ? new Date(parsed.data.scheduledAt)
          : null,
        customerPhoneSnapshot,
        dealerId: order.dealerId,
      })
      .returning();
  } catch (err) {
    const pg = err as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    const pgCode = pg.code ?? pg.cause?.code;
    const pgConstraint = pg.constraint ?? pg.cause?.constraint;
    // Partial unique index: one active job card per asset at a time.
    if (
      pgCode === "23505" &&
      pgConstraint === "job_cards_active_asset_unique"
    ) {
      res.status(409).json({
        error:
          "active_job_card_exists: this vehicle already has an active job card — complete or close it first",
      });
      return;
    }
    throw err;
  }

  if (card?.technicianUserId != null) {
    void notifyUser({
      userId: card.technicianUserId,
      dealerId: card.dealerId,
      type: "assignment",
      title: `Job card #${card.id} assigned to you`,
      body: `${card.title} — ${order.vehicleInfo}`,
      link: "/workshop",
    });
  }

  res.status(201).json(CreateJobCardResponse.parse(card));
});

const JobCardNoteParams = z.object({ id: z.coerce.number().int().positive() });
const CreateJobCardNoteBody = z.object({
  body: z.string().trim().min(1).max(4000),
});

router.get("/job-cards/:id/technician-notes", async (req, res): Promise<void> => {
  const params = JobCardNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db.select().from(jobCardsTable).where(
    and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
  );
  if (!card || !canActOnJobCard(res.locals.user, card)) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const notes = await db.select().from(jobCardTechnicianNotesTable).where(
    and(
      eq(jobCardTechnicianNotesTable.dealerId, dealerId),
      eq(jobCardTechnicianNotesTable.jobCardId, card.id),
    ),
  ).orderBy(jobCardTechnicianNotesTable.createdAt);
  res.json(notes);
});

router.post("/job-cards/:id/technician-notes", async (req, res): Promise<void> => {
  const params = JobCardNoteParams.safeParse(req.params);
  const parsed = CreateJobCardNoteBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db.select().from(jobCardsTable).where(
    and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
  );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (card.status !== "in_progress") {
    res.status(422).json({ error: "Technician notes can only be added while work is in progress" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, card)) {
    res.status(403).json({ error: "Only the assigned technician or a service approver can add notes" });
    return;
  }
  const author = res.locals.user?.name ?? res.locals.user?.email ?? "Unknown";
  const [note] = await db.insert(jobCardTechnicianNotesTable).values({
    dealerId, jobCardId: card.id, body: parsed.data.body,
    authorUserId: res.locals.user?.id ?? null, authorName: author,
  }).returning();
  const [order] = await db.select({ customerId: serviceOrdersTable.customerId }).from(serviceOrdersTable)
    .where(and(eq(serviceOrdersTable.id, card.serviceOrderId), eq(serviceOrdersTable.dealerId, dealerId)));
  if (order?.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId, customerId: order.customerId, domain: "service", kind: "job_card_technician_note",
      title: `Technician note added to job card #${card.id}`, detail: parsed.data.body,
      actor: author, isAgent: false, cause: `Job card #${card.id}`,
      refType: "job_card", refId: card.id,
    });
  }
  res.status(201).json(note);
});

router.patch("/job-cards/:id/waiting", async (req, res): Promise<void> => {
  const params = UpdateJobCardWaitingParams.safeParse(req.params);
  const parsed = UpdateJobCardWaitingBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: (params.success ? parsed : params).error?.message ?? "Invalid waiting update" });
    return;
  }
  const dealerId = activeDealerId(res);
  const [current] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId),
  ));
  if (!current) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, current)) {
    res.status(403).json({ error: "Only the assigned technician or a service approver can change waiting status" });
    return;
  }
  if (!ACTIVE_JOB_CARD_STATUSES.includes(current.status as (typeof ACTIVE_JOB_CARD_STATUSES)[number])) {
    res.status(422).json({ error: "Only an active job card can be put on hold or resumed" });
    return;
  }
  if (parsed.data.action === "resume" && current.rolloverStatus === "pending") {
    res.status(409).json({ error: "This carry-over is awaiting required rollover sign-off and cannot be resumed yet" });
    return;
  }
  if (parsed.data.action === "hold" && !parsed.data.reason) {
    res.status(422).json({ error: "Choose a waiting reason before placing work on hold" });
    return;
  }
  const actor = res.locals.user?.name ?? res.locals.user?.email ?? "System";
  const at = new Date();
  const event = {
    action: parsed.data.action,
    reason: (parsed.data.action === "hold" ? parsed.data.reason! : current.waitingReason) as JobWaitingReason | null,
    nextAction: parsed.data.action === "hold" ? parsed.data.nextAction?.trim() || null : current.nextAction,
    followUpDate: parsed.data.action === "hold"
      ? (parsed.data.followUpDate ? parsed.data.followUpDate.toISOString().slice(0, 10) : null)
      : current.followUpDate,
    byUserId: res.locals.user?.id ?? null,
    byName: actor,
    at: at.toISOString(),
  };
  const [card] = await db.update(jobCardsTable).set(
    parsed.data.action === "hold"
      ? {
          status: "on_hold", waitingReason: parsed.data.reason!,
          nextAction: parsed.data.nextAction?.trim() || null,
          followUpDate: parsed.data.followUpDate ? parsed.data.followUpDate.toISOString().slice(0, 10) : null,
          waitingHistory: [...(current.waitingHistory ?? []), event],
          timerSeconds: foldedTimerSeconds, timerStartedAt: null,
        }
      : {
          status: "in_progress", waitingReason: null,
          waitingHistory: [...(current.waitingHistory ?? []), event],
          timerStartedAt: new Date(),
        },
  ).where(and(
    eq(jobCardsTable.id, current.id), eq(jobCardsTable.dealerId, dealerId),
    eq(jobCardsTable.status, current.status),
    eq(jobCardsTable.estimateVersion, current.estimateVersion),
    eq(jobCardsTable.rolloverStatus, current.rolloverStatus),
  )).returning();
  if (!card) {
    res.status(409).json({ error: "Job card changed — reload and retry" });
    return;
  }
  res.json(UpdateJobCardWaitingResponse.parse(card));
});

router.post("/job-cards/:id/estimate/resend", async (req, res): Promise<void> => {
  const params = ResendJobCardEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId),
  ));
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, card)) {
    res.status(403).json({ error: "Only the assigned technician or a service approver can resend this estimate" });
    return;
  }
  if (card.payType !== "customer") {
    res.status(422).json({ error: "A customer-pay estimate is required before it can be sent." });
    return;
  }
  const [order] = await db.select().from(serviceOrdersTable).where(and(
    eq(serviceOrdersTable.id, card.serviceOrderId),
    eq(serviceOrdersTable.dealerId, dealerId),
  ));
  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  // Do not revoke a valid customer link merely to discover after the fact that
  // this dealer cannot deliver the replacement quote.
  const preflight = await preflightServiceEstimateQuote(order);
  if (!preflight.ok) {
    res.status(422).json({ error: preflight.message, code: preflight.code });
    return;
  }
  // The helper owns the sole destructive transaction: it rechecks this exact
  // version under lock, replaces its decision, and persists the linked outbox
  // row before committing. Never revise the card in this route first.
  const queued = await queueServiceEstimateQuote(order, card, {
    resendKey: String(Date.now()),
  });
  if (queued.outcome !== "queued") {
    res.status(queued.code === "quote_changed" || queued.code === "quote_already_open" ? 409 : 422)
      .json({ error: queued.message, code: queued.code });
    return;
  }
  // The committed queue transaction advanced the estimate version. Read that
  // resulting authoritative card only after it reports durable queue success.
  const [sentCard] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, card.id),
    eq(jobCardsTable.dealerId, dealerId),
  ));
  if (!sentCard) {
    res.status(409).json({ error: "The quote was queued but the job card is no longer available. Reload the workshop." });
    return;
  }
  res.status(202).json(ResendJobCardEstimateResponse.parse({
    jobCard: sentCard,
    ...queued,
  }));
});

/**
 * Records the required internal receipt of a customer's approval. This is not
 * a substitute for customer consent: the selected decision must be approved,
 * current and still valid while the job card is locked.
 */
router.post("/job-cards/:id/estimate/acknowledge", async (req, res): Promise<void> => {
  const params = AcknowledgeJobCardEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const user = res.locals.user;
  if (!user?.id) {
    res.status(401).json({ error: "An authenticated staff identity is required to acknowledge an estimate." });
    return;
  }
  const [card] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, params.data.id),
    eq(jobCardsTable.dealerId, dealerId),
  ));
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(user, card)) {
    res.status(403).json({ error: "Only the assigned service staff member or a service approver can acknowledge this estimate." });
    return;
  }
  const acknowledged = await db.transaction(async (tx) => {
    const [lockedCard] = await tx.select().from(jobCardsTable).where(and(
      eq(jobCardsTable.id, card.id),
      eq(jobCardsTable.dealerId, dealerId),
      eq(jobCardsTable.serviceOrderId, card.serviceOrderId),
    )).for("update");
    if (!lockedCard) return { kind: "missing" as const };
    if (
      lockedCard.estimateStaffAcknowledgedVersion === lockedCard.estimateVersion &&
      lockedCard.estimateStaffAcknowledgedDecisionId != null
    ) {
      const [existingDecision] = await tx.select({ id: serviceEstimateDecisionsTable.id })
        .from(serviceEstimateDecisionsTable)
        .where(and(
          eq(serviceEstimateDecisionsTable.id, lockedCard.estimateStaffAcknowledgedDecisionId),
          eq(serviceEstimateDecisionsTable.dealerId, dealerId),
          eq(serviceEstimateDecisionsTable.jobCardId, lockedCard.id),
          eq(serviceEstimateDecisionsTable.estimateVersion, lockedCard.estimateVersion),
          eq(serviceEstimateDecisionsTable.decision, "approved"),
          isNull(serviceEstimateDecisionsTable.invalidatedAt),
        ))
        .for("update");
      if (existingDecision) return { kind: "ok" as const, card: lockedCard };
    }
    const [decision] = await tx.select()
      .from(serviceEstimateDecisionsTable)
      .where(and(
        eq(serviceEstimateDecisionsTable.dealerId, dealerId),
        eq(serviceEstimateDecisionsTable.jobCardId, lockedCard.id),
        eq(serviceEstimateDecisionsTable.serviceOrderId, lockedCard.serviceOrderId),
        eq(serviceEstimateDecisionsTable.estimateVersion, lockedCard.estimateVersion),
        eq(serviceEstimateDecisionsTable.decision, "approved"),
        isNull(serviceEstimateDecisionsTable.invalidatedAt),
      ))
      .orderBy(desc(serviceEstimateDecisionsTable.decidedAt), desc(serviceEstimateDecisionsTable.id))
      .limit(1)
      .for("update");
    if (
      !decision ||
      lockedCard.estimateApprovedVersion !== lockedCard.estimateVersion
    ) {
      return { kind: "not_approved" as const };
    }
    const [updated] = await tx.update(jobCardsTable).set({
      estimateStaffAcknowledgedVersion: lockedCard.estimateVersion,
      estimateStaffAcknowledgedDecisionId: decision.id,
      estimateStaffAcknowledgedByUserId: user.id,
      estimateStaffAcknowledgedByName: user.name ?? user.email ?? `User #${user.id}`,
      estimateStaffAcknowledgedAt: new Date(),
    }).where(and(
      eq(jobCardsTable.id, lockedCard.id),
      eq(jobCardsTable.dealerId, dealerId),
      eq(jobCardsTable.estimateVersion, lockedCard.estimateVersion),
      eq(jobCardsTable.estimateApprovedVersion, lockedCard.estimateVersion),
    )).returning();
    return updated
      ? { kind: "ok" as const, card: updated }
      : { kind: "changed" as const };
  });
  if (acknowledged.kind === "missing") {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (acknowledged.kind === "not_approved") {
    res.status(422).json({
      error: "A current, non-stale customer-approved estimate decision is required before staff can acknowledge receipt.",
      unmet: ["customer_estimate_approval_required"],
    });
    return;
  }
  if (acknowledged.kind === "changed") {
    res.status(409).json({ error: "The estimate changed — reload and retry acknowledgement." });
    return;
  }
  res.json(AcknowledgeJobCardEstimateResponse.parse(acknowledged.card));
});

/** Staff-only canonical quote preview. Bearer tokens and customer decision
 * evidence are never returned; delivery data comes only from the email outbox. */
router.get("/job-cards/:id/estimate/preview", async (req, res): Promise<void> => {
  // The current estimate and its delivery state are dealer/user-scoped and
  // can change after a resend or customer decision. Never let a shared proxy
  // replay one staff member's commercial view to another request.
  res.set("Cache-Control", "no-store");
  const params = GetJobCardEstimatePreviewParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [joined] = await db.select({ card: jobCardsTable, order: serviceOrdersTable })
    .from(jobCardsTable)
    .innerJoin(serviceOrdersTable, and(
      eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
      eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId),
    ))
    .where(and(
      eq(jobCardsTable.id, params.data.id),
      eq(jobCardsTable.dealerId, dealerId),
    ));
  if (!joined) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, joined.card)) {
    res.status(403).json({ error: "Only the assigned service staff member or a service approver can preview this estimate." });
    return;
  }
  const [decision] = await db.select({
    id: serviceEstimateDecisionsTable.id,
    decision: serviceEstimateDecisionsTable.decision,
    invalidatedAt: serviceEstimateDecisionsTable.invalidatedAt,
    expiresAt: serviceEstimateDecisionsTable.expiresAt,
    decidedAt: serviceEstimateDecisionsTable.decidedAt,
  }).from(serviceEstimateDecisionsTable).where(and(
    eq(serviceEstimateDecisionsTable.dealerId, dealerId),
    eq(serviceEstimateDecisionsTable.jobCardId, joined.card.id),
    eq(serviceEstimateDecisionsTable.serviceOrderId, joined.order.id),
    eq(serviceEstimateDecisionsTable.estimateVersion, joined.card.estimateVersion),
  )).orderBy(desc(serviceEstimateDecisionsTable.createdAt), desc(serviceEstimateDecisionsTable.id)).limit(1);
  const [outbox] = await db.select({
    id: emailLogsTable.id,
    recipient: emailLogsTable.recipient,
    status: emailLogsTable.status,
    deliveryStatus: emailLogsTable.deliveryStatus,
    attempts: emailLogsTable.attempts,
    lastError: emailLogsTable.lastError,
    sentAt: emailLogsTable.sentAt,
    deliveredAt: emailLogsTable.deliveredAt,
  }).from(emailLogsTable).where(and(
    eq(emailLogsTable.dealerId, dealerId),
    eq(emailLogsTable.template, "service.estimate.ready"),
    decision
      ? eq(emailLogsTable.serviceEstimateDecisionId, decision.id)
      : sql`false`,
  )).orderBy(desc(emailLogsTable.createdAt), desc(emailLogsTable.id)).limit(1);
  const breakdown = await buildServiceEstimateBreakdown(db, joined.card);
  const recipient = await customerEmail(joined.order.customerId, dealerId);
  const state = !decision ? "draft" :
    decision.invalidatedAt ? "stale" :
    decision.decision ?? (decision.expiresAt <= new Date() ? "expired" : "open");
  res.json(GetJobCardEstimatePreviewResponse.parse({
    estimateVersion: joined.card.estimateVersion,
    total: breakdown.total,
    lines: breakdown.lines,
    customerRecipient: recipient.email,
    decision: {
      id: decision?.id ?? null,
      state,
      decidedAt: decision?.decidedAt ?? null,
    },
    delivery: outbox
      ? {
          state: outbox.deliveryStatus ?? outbox.status,
          recipient: outbox.recipient,
          attempts: outbox.attempts,
          lastError: outbox.lastError,
          sentAt: outbox.sentAt,
          deliveredAt: outbox.deliveredAt,
        }
      : {
          state: "not_queued",
          recipient: recipient.email,
          attempts: 0,
          lastError: null,
          sentAt: null,
          deliveredAt: null,
        },
  }));
});

router.patch("/job-cards/:id", async (req, res): Promise<void> => {
  const params = UpdateJobCardParams.safeParse(req.params);
  const parsed = UpdateJobCardBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const [existing] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, existing)) {
    res.status(403).json({
      error: "Claim this job card before changing it",
    });
    return;
  }
  if (
    isTechnicianRole(res.locals.user) &&
    (parsed.data.technicianUserId !== undefined ||
      parsed.data.technicianName !== undefined)
  ) {
    res.status(403).json({ error: "Technicians cannot reassign job cards" });
    return;
  }

  const {
    approveQuote,
    scheduledAt,
    customerPhoneSnapshot: _immutablePhoneSnapshot,
    ...updateFields
  } = parsed.data as typeof parsed.data & { customerPhoneSnapshot?: unknown };
  const patch: Record<string, unknown> = { ...updateFields };
  if (scheduledAt !== undefined) patch.scheduledAt = new Date(scheduledAt);
  if (parsed.data.intake !== undefined && !existing.intake && existing.receivedAt == null) {
    patch.receivedAt = new Date();
  }
  if (approveQuote) {
    res.status(422).json({
      error: "Customer approval must be recorded through the exact-version estimate link; staff cannot approve a quote on the customer's behalf.",
    });
    return;
  }
  const chargesChanging =
    parsed.data.quoteTotal !== undefined ||
    // Planned booking hours remain operational data; only quoted hours are
    // billable labour and therefore create a new estimate version.
    parsed.data.quotedLaborHours !== undefined ||
    parsed.data.laborRate !== undefined ||
    parsed.data.payType !== undefined;
  if (parsed.data.status === "in_progress" && existing.rolloverStatus === "pending") {
    res.status(409).json({ error: "Complete the pending rollover approvals before resuming this job card." });
    return;
  }
  if (chargesChanging) {
    // Staff-entered quote totals are never an approval/invoice authority. The
    // locked transaction below overwrites this with the canonical breakdown.
    delete patch.quoteTotal;
    patch.estimateVersion = sql`${jobCardsTable.estimateVersion} + 1`;
    patch.estimateApprovedVersion = null;
    patch.estimateApprovalAt = null;
    patch.estimateApprovalEvidence = null;
    patch.quoteApprovedAt = null;
    Object.assign(patch, clearEstimateStaffAcknowledgement);
  }
  if (
    parsed.data.status === "in_progress" &&
    existing.status === "open" &&
    !existing.startedAt
  ) {
    patch.startedAt = new Date();
  }
  // Work timer follows the status machine: entering in_progress starts a
  // segment (unless one is already running); leaving it folds the running
  // segment into the accumulated total.
  if (
    parsed.data.status &&
    parsed.data.status !== existing.status
  ) {
    if (parsed.data.status === "in_progress") {
      // Start a segment unless one is already running (SQL keeps this
      // race-free against a concurrent resume).
      patch.timerStartedAt = sql`coalesce(${jobCardsTable.timerStartedAt}, now())`;
    } else {
      // Leaving in_progress folds any running segment atomically from the
      // row's current values — a racing resume cannot strand a segment.
      patch.timerSeconds = foldedTimerSeconds;
      patch.timerStartedAt = null;
    }
  }
  if (parsed.data.status === "completed" && existing.status !== "completed") {
    if (existing.rolloverStatus === "pending") {
      res.status(409).json({ error: "Complete the pending rollover approvals before completing this job card." });
      return;
    }
    // Completion write-up is mandatory: the technician must record their
    // analysis of the service AND what work was performed before the card
    // can be marked completed (either in this request or already saved).
    const analysis =
      parsed.data.serviceAnalysis?.trim() || existing.serviceAnalysis?.trim();
    const performed =
      parsed.data.workPerformed?.trim() || existing.workPerformed?.trim();
    const missing: string[] = [];
    if (!analysis) missing.push("service_analysis_required");
    if (!performed) missing.push("work_performed_required");
    if (missing.length > 0) {
      res.status(422).json({
        error:
          "Completion write-up required — record the service analysis and the work performed before marking this job card completed.",
        unmet: missing,
      });
      return;
    }
    patch.completedAt = new Date();
  }

  let becameReady = false;
  const card = await db.transaction(async (tx) => {
    const [lockedCard] = await tx.select().from(jobCardsTable).where(and(
      eq(jobCardsTable.id, existing.id),
      eq(jobCardsTable.dealerId, existing.dealerId),
    )).for("update");
    if (!lockedCard || lockedCard.estimateVersion !== existing.estimateVersion ||
        lockedCard.status !== existing.status) {
      return undefined;
    }
    if (
      ["in_progress", "completed"].includes(parsed.data.status ?? "") &&
      lockedCard.rolloverStatus === "pending"
    ) {
      throw Object.assign(new Error("locked_rollover_gate"), { status: 422 });
    }
    if (chargesChanging) {
      const [issuedInvoice] = await tx.select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(and(
          eq(serviceInvoicesTable.jobCardId, lockedCard.id),
          eq(serviceInvoicesTable.dealerId, lockedCard.dealerId),
        ))
        .for("update");
      if (issuedInvoice) {
        throw Object.assign(new Error("issued_invoice_charge_mutation"), { status: 422 });
      }
      const prospectiveCard = {
        ...lockedCard,
        payType: parsed.data.payType ?? lockedCard.payType,
        laborHours: parsed.data.laborHours ?? lockedCard.laborHours,
        quotedLaborHours: parsed.data.quotedLaborHours ?? lockedCard.quotedLaborHours,
        laborRate: parsed.data.laborRate ?? lockedCard.laborRate,
      };
      const breakdown = await buildServiceEstimateBreakdown(tx, prospectiveCard);
      patch.quoteTotal = breakdown.total;
    }
    const [updatedCard] = await tx
      .update(jobCardsTable)
      .set(patch)
      .where(
        and(
          eq(jobCardsTable.id, params.data.id),
          eq(jobCardsTable.dealerId, existing.dealerId),
          eq(jobCardsTable.status, existing.status),
          eq(jobCardsTable.estimateVersion, existing.estimateVersion),
        ),
      )
      .returning();
    if (updatedCard?.status === "cancelled") {
      await releaseJobPartHolds(tx, existing.dealerId, updatedCard.id);
    }
    if (
      updatedCard &&
      (parsed.data.technicianUserId !== undefined ||
        parsed.data.technicianName !== undefined)
    ) {
      await tx.update(serviceOrdersTable).set({
        technicianUserId: updatedCard.technicianUserId,
        technician: updatedCard.technicianName,
      }).where(and(
        eq(serviceOrdersTable.id, updatedCard.serviceOrderId),
        eq(serviceOrdersTable.dealerId, updatedCard.dealerId),
      ));
    }
    if (
      updatedCard &&
      parsed.data.status === "completed" &&
      existing.status !== "completed"
    ) {
      const unfinished = await tx.select({ id: jobCardsTable.id }).from(jobCardsTable).where(and(
        eq(jobCardsTable.serviceOrderId, updatedCard.serviceOrderId),
        eq(jobCardsTable.dealerId, updatedCard.dealerId),
        sql`${jobCardsTable.status} not in ('completed', 'closed', 'cancelled')`,
      ));
      if (unfinished.length === 0) {
        const [currentOrder] = await tx.select({ status: serviceOrdersTable.status })
          .from(serviceOrdersTable).where(and(
            eq(serviceOrdersTable.id, updatedCard.serviceOrderId),
            eq(serviceOrdersTable.dealerId, updatedCard.dealerId),
          ));
        const completionEvent = {
          from: currentOrder?.status ?? "in_progress",
          to: "resolved",
          justification: `All job cards complete; job card #${updatedCard.id} triggered readiness`,
          byUserId: res.locals.user?.id ?? null,
          byName: res.locals.user?.name ?? res.locals.user?.email ?? "Unknown",
          at: new Date().toISOString(),
        };
        const [resolved] = await tx.update(serviceOrdersTable).set({
          status: "resolved",
          stageHistory: sql`coalesce(${serviceOrdersTable.stageHistory}, '[]'::jsonb) || ${JSON.stringify([completionEvent])}::jsonb`,
        }).where(and(
          eq(serviceOrdersTable.id, updatedCard.serviceOrderId),
          eq(serviceOrdersTable.dealerId, updatedCard.dealerId),
          sql`${serviceOrdersTable.status} in ('acknowledged', 'in_progress', 'on_hold')`,
        )).returning({ id: serviceOrdersTable.id });
        becameReady = Boolean(resolved);
      }
    }
    if (updatedCard && chargesChanging) {
      // Repricing and quote transport share the locked card serialization
      // point. This cancels queued, retryable, and claimed old deliveries
      // before the replacement version can be sent explicitly by staff.
      await invalidateServiceEstimate(tx, lockedCard.dealerId, lockedCard.id);
    }
    return updatedCard;
  }).catch((error) => {
    const failure = error as Error & { status?: number };
    if (failure.status === 422) {
      res.status(422).json({
        error: (failure.message === "locked_rollover_gate")
          ? "The rollover state changed — reload before resuming or completing work."
          : "An issued invoice is immutable; record a linked financial adjustment instead.",
      });
      return undefined;
    }
    throw error;
  });
  if (!card) {
    if (res.headersSent) return;
    res.status(409).json({ error: "Job card changed — reload and retry" });
    return;
  }

  if (card) {
    const [order] = await db
      .select()
      .from(serviceOrdersTable)
      .where(
        and(
          eq(serviceOrdersTable.id, card.serviceOrderId),
          eq(serviceOrdersTable.dealerId, card.dealerId),
        ),
      );
    if (order && !existing.intake && card.intake) {
      onJobCardIntakeRecorded(order, card);
    }
    if (order && parsed.data.status && parsed.data.status !== existing.status) {
      onJobCardStatusChanged(existing, card, order, becameReady);
    }
    if (
      order &&
      order.status === "acknowledged" &&
      existing.scheduledAt?.toISOString() !== card.scheduledAt?.toISOString()
    ) {
      onServiceAppointmentChanged(order);
    }
    if (
      parsed.data.status === "completed" &&
      existing.status !== "completed"
    ) {
      const recipient = await customerEmail(order?.customerId, card.dealerId);
      if (order && recipient.email) {
        await enqueueEmail({
          dealerId: card.dealerId,
          template: "service.quality.complete",
          to: recipient.email,
          customerId: order.customerId,
          dedupeKey: `svc:${order.id}:quality-complete`,
          data: {
            vehicle: order.vehicleInfo,
            ...(card.workPerformed ? { work: card.workPerformed } : {}),
          },
        });
      }
    }
  }

  // Service completed → automatically issue the invoice and email it to the
  // customer (PDF attached). Best-effort: an undecided surcharge or an
  // already-existing invoice leaves the manual "Generate invoice" path open.
  if (card && parsed.data.status === "completed" && existing.status !== "completed") {
    const result = await issueServiceInvoice(card).catch((err) => {
      logger.error({ err, jobCardId: card.id }, "auto-invoice on completion failed");
      return null;
    });
    if (result && !result.ok && result.status !== 409) {
      logger.warn(
        { jobCardId: card.id, reason: result.error },
        "auto-invoice skipped on completion",
      );
    }
  }

  if (
    card &&
    parsed.data.technicianUserId != null &&
    parsed.data.technicianUserId !== existing.technicianUserId
  ) {
    void notifyUser({
      userId: parsed.data.technicianUserId,
      dealerId: card.dealerId,
      type: "assignment",
      title: `Job card #${card.id} assigned to you`,
      body: card.title,
      link: "/workshop",
    });
  }

  res.json(UpdateJobCardResponse.parse(card));
});

// ---------------------------------------------------------------------------
// Work timer: technicians pause/resume without changing the card's status
// ---------------------------------------------------------------------------

router.post("/job-cards/:id/apply-current-labour-rate", async (req, res): Promise<void> => {
  const params = ApplyCurrentJobCardLabourRateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [existing] = await db
    .select()
    .from(jobCardsTable)
    .where(and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)));
  if (!existing) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, existing)) {
    res.status(403).json({ error: "Claim this job card before changing it" });
    return;
  }
  const settings = await getServiceSettings(dealerId);
  const [order] = existing.serviceOrderId == null
    ? []
    : await db
        .select({ brand: serviceOrdersTable.brand })
        .from(serviceOrdersTable)
        .where(and(
          eq(serviceOrdersTable.id, existing.serviceOrderId),
          eq(serviceOrdersTable.dealerId, dealerId),
        ))
        .limit(1);
  const labourRate = calculateLabourRateGyd(
    settings.labourUsdToGydRate,
    labourUsdPerHourForBrand(order?.brand, settings.brandLabourRates),
  );

  try {
    const card = await db.transaction(async (tx) => {
      const [lockedCard] = await tx
        .select()
        .from(jobCardsTable)
        .where(and(eq(jobCardsTable.id, existing.id), eq(jobCardsTable.dealerId, dealerId)))
        .for("update");
      if (!lockedCard || lockedCard.estimateVersion !== existing.estimateVersion ||
          lockedCard.status !== existing.status) {
        throw Object.assign(new Error("job_card_changed"), { status: 409 });
      }
      if (lockedCard.laborRate === labourRate) return lockedCard;
      const [issuedInvoice] = await tx
        .select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(and(
          eq(serviceInvoicesTable.jobCardId, lockedCard.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ))
        .for("update");
      if (issuedInvoice) {
        throw Object.assign(new Error("issued_invoice_charge_mutation"), { status: 422 });
      }
      const prospectiveCard = { ...lockedCard, laborRate: labourRate };
      const breakdown = await buildServiceEstimateBreakdown(tx, prospectiveCard);
      const [updatedCard] = await tx
        .update(jobCardsTable)
        .set({
          laborRate: labourRate,
          quoteTotal: breakdown.total,
          estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
          estimateApprovedVersion: null,
          estimateApprovalAt: null,
          estimateApprovalEvidence: null,
          quoteApprovedAt: null,
          ...clearEstimateStaffAcknowledgement,
        })
        .where(and(
          eq(jobCardsTable.id, lockedCard.id),
          eq(jobCardsTable.dealerId, dealerId),
          eq(jobCardsTable.status, lockedCard.status),
          eq(jobCardsTable.estimateVersion, lockedCard.estimateVersion),
        ))
        .returning();
      if (!updatedCard) {
        throw Object.assign(new Error("job_card_changed"), { status: 409 });
      }
      await invalidateServiceEstimate(tx, dealerId, lockedCard.id);
      return updatedCard;
    });
    res.json(ApplyCurrentJobCardLabourRateResponse.parse(card));
  } catch (error) {
    const failure = error as Error & { status?: number };
    if (failure.status === 409) {
      res.status(409).json({ error: "Job card changed — reload and retry" });
      return;
    }
    if (failure.status === 422) {
      res.status(422).json({
        error: "An issued invoice is immutable; record a linked financial adjustment instead.",
      });
      return;
    }
    throw error;
  }
});

router.post("/job-cards/:id/timer", async (req, res): Promise<void> => {
  const params = ToggleJobCardTimerParams.safeParse(req.params);
  const body = ToggleJobCardTimerBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: (params.success ? body : params).error?.message ?? "Invalid",
    });
    return;
  }
  const [existing] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, existing)) {
    res.status(403).json({
      error:
        "Only the assigned technician or the Service Manager can control this job's timer",
    });
    return;
  }
  if (existing.status !== "in_progress") {
    res.status(409).json({
      error: "Timer only runs while the job is in progress",
    });
    return;
  }
  // Compare-and-set: the UPDATE only lands when the card is still in progress
  // AND the timer is in the expected state, so concurrent pause/resume/status
  // requests cannot double-fold or drop a running segment.
  const pausing = body.data.action === "pause";
  if (!pausing && existing.rolloverStatus === "pending") {
    res.status(409).json({ error: "Complete the pending rollover approvals before resuming this timer." });
    return;
  }
  const [card] = await db
    .update(jobCardsTable)
    .set(
      pausing
        ? { timerSeconds: foldedTimerSeconds, timerStartedAt: null }
        : { timerStartedAt: new Date() },
    )
    .where(
      and(
        eq(jobCardsTable.id, existing.id),
        eq(jobCardsTable.dealerId, existing.dealerId),
        eq(jobCardsTable.status, "in_progress"),
        !pausing
          ? eq(jobCardsTable.estimateVersion, existing.estimateVersion)
          : undefined,
        !pausing
          ? eq(jobCardsTable.rolloverStatus, existing.rolloverStatus)
          : undefined,
        pausing
          ? sql`${jobCardsTable.timerStartedAt} is not null`
          : isNull(jobCardsTable.timerStartedAt),
      ),
    )
    .returning();
  if (!card) {
    res.status(409).json({
      error: pausing ? "Timer is already paused" : "Timer is already running",
    });
    return;
  }
  res.json(ToggleJobCardTimerResponse.parse(card));
});

// ---------------------------------------------------------------------------
// Reopen: completed/closed card goes back to in-progress for more work
// ---------------------------------------------------------------------------

router.post("/job-cards/:id/reopen", async (req, res): Promise<void> => {
  const params = ReopenJobCardParams.safeParse(req.params);
  const body = ReopenJobCardBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({
      error: (params.success ? body : params).error?.message ?? "Invalid",
    });
    return;
  }
  const [existing] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, existing)) {
    res.status(403).json({
      error:
        "Only the assigned technician or the Service Manager can reopen this job card",
    });
    return;
  }
  if (existing.status !== "completed" && existing.status !== "closed") {
    res
      .status(409)
      .json({ error: "Only completed or closed job cards can be reopened" });
    return;
  }
  // A PAID invoice locks the card shut — reopening would let more work land
  // on a bill the customer already settled. Issued (unpaid) invoices keep
  // the adjustments path open, so they don't block a reopen.
  const [paidInvoice] = await db
    .select({ id: serviceInvoicesTable.id })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.jobCardId, existing.id),
        eq(serviceInvoicesTable.dealerId, existing.dealerId),
        eq(serviceInvoicesTable.status, "paid"),
      ),
    );
  if (paidInvoice) {
    res.status(409).json({
      error:
        "This job's invoice is already paid — open a new job card for additional work instead of reopening this one.",
    });
    return;
  }
  if (existing.rolloverStatus === "pending") {
    res.status(409).json({ error: "Complete the pending rollover approvals before reopening this job card." });
    return;
  }
  let card: JobCard | undefined;
  try {
    [card] = await db
      .update(jobCardsTable)
      .set({
        status: "in_progress",
        completedAt: null,
        timerStartedAt: new Date(),
        ...(body.data?.reason
          ? {
              notes: existing.notes
                ? `${existing.notes}\nReopened: ${body.data.reason}`
                : `Reopened: ${body.data.reason}`,
            }
          : {}),
      })
      .where(and(
        eq(jobCardsTable.id, existing.id),
        eq(jobCardsTable.dealerId, existing.dealerId),
        eq(jobCardsTable.status, existing.status),
        eq(jobCardsTable.estimateVersion, existing.estimateVersion),
        eq(jobCardsTable.rolloverStatus, existing.rolloverStatus),
        sql`not exists (
          select 1 from ${serviceInvoicesTable}
          where ${serviceInvoicesTable.jobCardId} = ${jobCardsTable.id}
            and ${serviceInvoicesTable.dealerId} = ${jobCardsTable.dealerId}
            and ${serviceInvoicesTable.status} = 'paid'
        )`,
      ))
      .returning();
  } catch (err) {
    const pg = err as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    const pgCode = pg.code ?? pg.cause?.code;
    const pgConstraint = pg.constraint ?? pg.cause?.constraint;
    if (
      pgCode === "23505" &&
      pgConstraint === "job_cards_one_running_timer_per_technician"
    ) {
      res.status(409).json({
        error: "This technician already has a running job-card timer. Pause or stop that work before reopening this card.",
      });
      return;
    }
    // Partial unique index: one active job card per asset at a time.
    if (
      pgCode === "23505" &&
      pgConstraint === "job_cards_active_asset_unique"
    ) {
      res.status(409).json({
        error:
          "This vehicle already has another active job card — complete or close it before reopening this one.",
      });
      return;
    }
    throw err;
  }
  if (card) {
    const [order] = await db
      .select()
      .from(serviceOrdersTable)
      .where(eq(serviceOrdersTable.id, card.serviceOrderId));
    await db.insert(timelineEventsTable).values({
      dealerId: card.dealerId,
      customerId: order?.customerId ?? null,
      domain: "service",
      kind: "job_card_reopened",
      title: `Job card #${card.id} reopened`,
      detail: body.data?.reason ?? null,
      actor: res.locals.user?.name ?? "Service",
    });
    if (card.technicianUserId != null) {
      void notifyUser({
        userId: card.technicianUserId,
        dealerId: card.dealerId,
        type: "assignment",
        title: `Job card #${card.id} reopened`,
        body: card.title,
        link: "/workshop",
      });
    }
  }
  res.json(ReopenJobCardResponse.parse(card));
});

// ---------------------------------------------------------------------------
// Multi-day rollover (FR-SR-06): dual sign-off before a card carries over
// ---------------------------------------------------------------------------

const ACTIVE_CARD_STATUSES = new Set(["open", "in_progress", "on_hold"]);

router.post("/job-cards/:id/rollover", async (req, res): Promise<void> => {
  const params = RolloverJobCardParams.safeParse(req.params);
  const parsed = RolloverJobCardBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!ACTIVE_CARD_STATUSES.has(card.status)) {
    res.status(422).json({
      error: `Only an active job card can be rolled over (this one is ${card.status})`,
    });
    return;
  }
  const toDate = toDateString(parsed.data.toDate);
  const today = zonedDayKey(new Date(), await dealerTimezone(dealerId));
  if (!toDate || toDate <= today) {
    res.status(422).json({ error: "Rollover date must be a future day" });
    return;
  }
  // Sign-offs are immutable: a pending rollover (including one with partial
  // signatures) can never be replaced or have its signatures cleared by a new
  // request. Only "none" (never requested) or "approved" (fully signed and
  // executed) cards accept a new request — and an approved record is archived
  // into the card's notes as an append-only audit line first.
  if (card.rolloverStatus === "pending") {
    res.status(422).json({
      error:
        "A rollover is already awaiting sign-off — it must be fully approved before another can be requested",
    });
    return;
  }
  const auditLine =
    card.rolloverStatus === "approved"
      ? `[Rollover audit] carried to ${card.rolloverToDate ?? "?"} — manager: ${card.rolloverManagerApprovedBy ?? "?"} @ ${card.rolloverManagerApprovedAt?.toISOString() ?? "?"}; technician: ${card.rolloverTechApprovedBy ?? "?"} @ ${card.rolloverTechApprovedAt?.toISOString() ?? "?"}`
      : null;
  // CAS on the observed rollover status so a concurrent request or sign-off
  // can't be raced past the guard above.
  const [updated] = await db
    .update(jobCardsTable)
    .set({
      rolloverStatus: "pending",
      rolloverToDate: toDate,
      rolloverReason: parsed.data.reason ?? null,
      rolloverRequestedBy: res.locals.user?.name ?? res.locals.user?.email ?? "Staff",
      rolloverRequestedAt: new Date(),
      rolloverManagerApprovedBy: null,
      rolloverManagerApprovedAt: null,
      rolloverTechApprovedBy: null,
      rolloverTechApprovedAt: null,
      ...(auditLine
        ? { notes: card.notes ? `${card.notes}\n${auditLine}` : auditLine }
        : {}),
    })
    .where(
      and(
        eq(jobCardsTable.id, card.id),
        eq(jobCardsTable.dealerId, dealerId),
        eq(jobCardsTable.rolloverStatus, card.rolloverStatus),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({ error: "Job card changed — reload and retry" });
    return;
  }
  const managerIds = await generalManagers(dealerId);
  if (managerIds.length) {
    await db.insert(tasksTable).values(
      managerIds.map((managerId) => ({
        dealerId,
        title: `Approve rollover · JC #${updated.id}`,
        description: `${updated.title} · move to ${toDate}${updated.rolloverReason ? ` · ${updated.rolloverReason}` : ""}`,
        assigneeUserId: managerId,
        createdByUserId: res.locals.user?.id ?? null,
        dueDate: today,
        kind: "service_rollover_approval",
        priority: "high",
      })),
    );
  }
  res.json(RolloverJobCardResponse.parse(updated));
});

router.post(
  "/job-cards/:id/rollover/approve",
  async (req, res): Promise<void> => {
    const params = ApproveJobCardRolloverParams.safeParse(req.params);
    const parsed = ApproveJobCardRolloverBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const user = res.locals.user;
    const [card] = await db
      .select()
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.id, params.data.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      );
    if (!card) {
      res.status(404).json({ error: "Job card not found" });
      return;
    }
    if (card.rolloverStatus !== "pending") {
      res.status(422).json({ error: "No pending rollover on this job card" });
      return;
    }
    const signer = user?.name ?? user?.email ?? "Staff";
    if (parsed.data.as === "manager") {
      if (!isServiceApprover(user)) {
        res.status(403).json({
          error: "Only the Service Manager or Management can sign off as manager",
        });
        return;
      }
    } else if (
      card.technicianUserId == null ||
      user?.id !== card.technicianUserId
    ) {
      // Technician sign-off must come from the assigned technician.
      res.status(403).json({
        error: "Only the assigned technician can sign off as technician",
      });
      return;
    }

    // Sign-offs are immutable: the UPDATE only lands when the rollover is
    // still pending AND this capacity's slot is empty, so a concurrent
    // duplicate cannot overwrite who signed or when.
    const updated = await db.transaction(async (tx) => {
      const slotPredicate =
        parsed.data.as === "manager"
          ? isNull(jobCardsTable.rolloverManagerApprovedAt)
          : isNull(jobCardsTable.rolloverTechApprovedAt);
      const signPatch: Partial<typeof jobCardsTable.$inferInsert> =
        parsed.data.as === "manager"
          ? {
              rolloverManagerApprovedBy: signer,
              rolloverManagerApprovedAt: new Date(),
            }
          : {
              rolloverTechApprovedBy: signer,
              rolloverTechApprovedAt: new Date(),
            };
      const [signed] = await tx
        .update(jobCardsTable)
        .set(signPatch)
        .where(
          and(
            eq(jobCardsTable.id, card.id),
            eq(jobCardsTable.dealerId, dealerId),
            eq(jobCardsTable.rolloverStatus, "pending"),
            slotPredicate,
          ),
        )
        .returning();
      if (!signed) return null;

      // Second signature completes the rollover: the card's scheduled date
      // moves to the approved carry-over day.
      if (
        signed.rolloverManagerApprovedAt != null &&
        signed.rolloverTechApprovedAt != null
      ) {
        const finalPatch: Partial<typeof jobCardsTable.$inferInsert> = {
          rolloverStatus: "approved",
        };
        if (signed.rolloverToDate) {
          // Keep the card's original wall-clock time on the approved
          // carry-over day, evaluated in the dealership timezone.
          const tz = await dealerTimezone(dealerId);
          const prev = zonedParts(signed.scheduledAt ?? new Date(), tz);
          const [ry, rm, rd] = signed.rolloverToDate.split("-").map(Number);
          finalPatch.scheduledAt = zonedTimeToUtc(
            tz,
            ry!,
            rm!,
            rd!,
            prev.hour,
            prev.minute,
          );
        }
        const [finalized] = await tx
          .update(jobCardsTable)
          .set(finalPatch)
          .where(
            and(
              eq(jobCardsTable.id, card.id),
              eq(jobCardsTable.dealerId, dealerId),
              eq(jobCardsTable.rolloverStatus, "pending"),
            ),
          )
          .returning();
        if (finalized) {
          // FR-COM-01: tell the customer their job carries to another day.
          const [parent] = await tx
            .select()
            .from(serviceOrdersTable)
            .where(
              and(
                eq(serviceOrdersTable.id, finalized.serviceOrderId),
                eq(serviceOrdersTable.dealerId, dealerId),
              ),
            );
          if (parent) {
            onJobCardRolloverApproved({
              dealerId,
              jobCardId: finalized.id,
              serviceOrderId: parent.id,
              customerId: parent.customerId,
              vehicleInfo: parent.vehicleInfo,
              serviceType: parent.type,
              toDate: finalized.rolloverToDate,
              reason: finalized.rolloverReason,
            });
          }
        }
        return finalized ?? signed;
      }
      return signed;
    });
    if (!updated) {
      res.status(409).json({
        error:
          parsed.data.as === "manager"
            ? "Manager sign-off already recorded (or rollover no longer pending)"
            : "Technician sign-off already recorded (or rollover no longer pending)",
      });
      return;
    }
    if (parsed.data.as === "manager") {
      await db
        .update(tasksTable)
        .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(tasksTable.dealerId, dealerId),
            eq(tasksTable.kind, "service_rollover_approval"),
            eq(tasksTable.title, `Approve rollover · JC #${card.id}`),
            eq(tasksTable.status, "open"),
          ),
        );
    }
    res.json(ApproveJobCardRolloverResponse.parse(updated));
  },
);

// ---------------------------------------------------------------------------
// Late-service surcharge decision (FR-SR-07): apply or waive
// ---------------------------------------------------------------------------

router.post("/job-cards/:id/surcharge", async (req, res): Promise<void> => {
  const params = DecideJobCardSurchargeParams.safeParse(req.params);
  const parsed = DecideJobCardSurchargeBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const settings = await getServiceSettings(dealerId);
  const decidedBy = res.locals.user?.name ?? res.locals.user?.email ?? "Staff";
  const apply = parsed.data.action === "apply";
  const amount = apply
    ? parsed.data.amount ??
      (card.surchargeAmount > 0 ? card.surchargeAmount : settings.lateSurchargeFee)
    : card.surchargeAmount;
  const [updated] = await db.transaction(async (tx) => {
    // Card is the shared serialization point for invoice, surcharge and every
    // billable-line mutation. Never check invoice state outside this lock.
    const [current] = await tx.select().from(jobCardsTable).where(and(
      eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId),
    )).for("update");
    if (!current || current.estimateVersion !== card.estimateVersion) return [];
    const [invoiced] = await tx.select({ id: serviceInvoicesTable.id })
      .from(serviceInvoicesTable)
      .where(and(eq(serviceInvoicesTable.jobCardId, card.id), eq(serviceInvoicesTable.dealerId, dealerId)))
      .for("update");
    if (invoiced) throw Object.assign(new Error(`Invoice #${invoiced.id} already issued — adjust the invoice instead`), { status: 422 });
    const nextAmount = apply ? amount : 0;
    const breakdown = await buildServiceEstimateBreakdown(tx, {
      ...current,
      surchargeStatus: apply ? "applied" : "waived",
      surchargeAmount: nextAmount,
    });
    const [changed] = await tx.update(jobCardsTable).set({
      surchargeStatus: apply ? "applied" : "waived",
      surchargeAmount: nextAmount,
      surchargeDecidedBy: decidedBy,
      surchargeDecidedAt: new Date(),
      quoteTotal: breakdown.total,
      estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
      estimateApprovedVersion: null,
      estimateApprovalAt: null,
      estimateApprovalEvidence: null,
      quoteApprovedAt: null,
      ...clearEstimateStaffAcknowledgement,
    }).where(and(
      eq(jobCardsTable.id, current.id), eq(jobCardsTable.dealerId, dealerId),
      eq(jobCardsTable.estimateVersion, current.estimateVersion),
    )).returning();
    if (changed) await invalidateServiceEstimate(tx, dealerId, changed.id);
    return changed ? [changed] : [];
  }).catch((error) => {
    const failure = error as Error & { status?: number };
    if (failure.status === 422) {
      res.status(422).json({ error: failure.message });
      return [];
    }
    throw error;
  });
  if (!updated) {
    if (!res.headersSent) res.status(409).json({ error: "Job card changed — reload and retry" });
    return;
  }
  res.json(DecideJobCardSurchargeResponse.parse(updated));
});

// ---------------------------------------------------------------------------
// Job card part lines (issue decrements stock, return restocks)
// ---------------------------------------------------------------------------

router.get("/job-cards/:id/parts", async (req, res): Promise<void> => {
  const params = ListJobCardPartsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.jobCardId, params.data.id),
        eq(jobCardPartsTable.dealerId, activeDealerId(res)),
      ),
    )
    .orderBy(desc(jobCardPartsTable.createdAt));
  const parsedRows = ListJobCardPartsResponse.parse(rows);
  res.json(parsedRows.map((row, index) => ({
    ...row, inventoryHoldId: rows[index].inventoryHoldId,
    inventoryLocationId: rows[index].inventoryLocationId, inventoryBinId: rows[index].inventoryBinId,
    issuedQuantity: rows[index].issuedQuantity, issuedAt: rows[index].issuedAt,
  })));
});

router.post("/job-cards/:id/parts/:lineId/issue", idempotent("service.part.issue"), async (req, res): Promise<void> => {
  const ids = z.object({ id: z.coerce.number().int().positive(), lineId: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!ids.success) { res.status(400).json({ error: "Invalid job card or line id" }); return; }
  const dealerId = activeDealerId(res);
  try {
    const issued = await db.transaction(async tx => {
      const [card] = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.id, ids.data.id), eq(jobCardsTable.dealerId, dealerId),
      )).for("update");
      if (!card) throw Object.assign(new Error("Job card not found"), { status: 404 });
      if (["cancelled", "closed"].includes(card.status)) throw Object.assign(new Error("Cannot issue parts to a terminal job"), { status: 422 });
      return issueJobParts(tx, dealerId, card.id, ids.data.lineId);
    });
    for (const line of issued) {
      checkLowStockCrossing(line.part, line.part.stock, line.part.stock - line.quantity);
      enqueueStockEntrySync({
      dealerId, partId: line.partId, qty: line.quantity, direction: "out",
      entityType: "job_card_part", entityId: line.id,
      remark: `AURA job card #${ids.data.id} — explicit part issue`,
      dedupeKey: `erp:se:jcp:${dealerId}:${line.id}`,
    });
    }
    const [line] = await db.select().from(jobCardPartsTable).where(and(
      eq(jobCardPartsTable.id, ids.data.lineId), eq(jobCardPartsTable.dealerId, dealerId),
    ));
    res.json(line);
  } catch (error) {
    const failure = error as Error & { status?: number };
    res.status(failure.status ?? 409).json({ error: failure.message });
  }
});

router.patch("/job-cards/:id/parts/:lineId", async (req, res): Promise<void> => {
  const ids = z.object({ id: z.coerce.number().int().positive(), lineId: z.coerce.number().int().positive() }).safeParse(req.params);
  const body = z.object({ quantity: z.number().int().positive(),
    locationId: z.number().int().positive().optional(), binId: z.number().int().positive().nullable().optional(),
  }).safeParse(req.body);
  if (!ids.success || !body.success) { res.status(400).json({ error: "Invalid part update" }); return; }
  const dealerId = activeDealerId(res);
  try {
    const result = await db.transaction(async tx => {
      const [card] = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.id, ids.data.id), eq(jobCardsTable.dealerId, dealerId),
      )).for("update");
      if (!card) throw Object.assign(new Error("Job card not found"), { status: 404 });
      if (["cancelled", "closed"].includes(card.status)) throw Object.assign(new Error("Terminal job cannot reserve parts"), { status: 422 });
      const [invoice] = await tx.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable).where(and(
        eq(serviceInvoicesTable.jobCardId, card.id), eq(serviceInvoicesTable.dealerId, dealerId),
      ));
      if (invoice) throw Object.assign(new Error("Invoiced lines cannot be changed"), { status: 422 });
      const [line] = await tx.select().from(jobCardPartsTable).where(and(
        eq(jobCardPartsTable.id, ids.data.lineId), eq(jobCardPartsTable.jobCardId, card.id),
        eq(jobCardPartsTable.dealerId, dealerId),
      )).for("update");
      if (!line) throw Object.assign(new Error("Part line not found"), { status: 404 });
      if (line.kind !== "issue" || issuedUnits(line) > 0) throw Object.assign(new Error("Issued parts require a linked return"), { status: 422 });
      if (line.inventoryHoldId) await releaseHold(tx, dealerId, line.inventoryHoldId);
      const [changed] = await tx.update(jobCardPartsTable).set({
        quantity: body.data.quantity, issuedQuantity: 0,
        inventoryLocationId: body.data.locationId ?? line.inventoryLocationId,
        inventoryBinId: body.data.binId === undefined ? line.inventoryBinId : body.data.binId,
      }).where(and(eq(jobCardPartsTable.id, line.id), eq(jobCardPartsTable.dealerId, dealerId))).returning();
      const hold = await reserveJobPart(tx, changed);
      const breakdown = await buildServiceEstimateBreakdown(tx, card);
      await tx.update(jobCardsTable).set({
        quoteTotal: breakdown.total, estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
        estimateApprovedVersion: null, estimateApprovalAt: null, estimateApprovalEvidence: null,
        quoteApprovedAt: null, ...clearEstimateStaffAcknowledgement,
      }).where(and(eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId)));
      await invalidateServiceEstimate(tx, dealerId, card.id);
      return { ...changed, inventoryHoldId: hold.id, inventoryLocationId: hold.locationId,
        inventoryBinId: hold.binId, backordered: hold.backorderRisk };
    });
    res.json(result);
  } catch (error) {
    const failure = error as Error & { status?: number };
    res.status(failure.status ?? 409).json({ error: failure.message });
  }
});

router.delete("/job-cards/:id/parts/:lineId", async (req, res): Promise<void> => {
  const ids = z.object({ id: z.coerce.number().int().positive(), lineId: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!ids.success) { res.status(400).json({ error: "Invalid job card or line id" }); return; }
  const dealerId = activeDealerId(res);
  try {
    await db.transaction(async tx => {
      const [card] = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.id, ids.data.id), eq(jobCardsTable.dealerId, dealerId),
      )).for("update");
      if (!card) throw Object.assign(new Error("Job card not found"), { status: 404 });
      const [invoice] = await tx.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable).where(and(
        eq(serviceInvoicesTable.jobCardId, card.id), eq(serviceInvoicesTable.dealerId, dealerId),
      ));
      if (invoice) throw Object.assign(new Error("Invoiced lines cannot be removed"), { status: 422 });
      const [line] = await tx.select().from(jobCardPartsTable).where(and(
        eq(jobCardPartsTable.id, ids.data.lineId), eq(jobCardPartsTable.jobCardId, card.id),
        eq(jobCardPartsTable.dealerId, dealerId),
      )).for("update");
      if (!line) throw Object.assign(new Error("Part line not found"), { status: 404 });
      if (line.kind !== "issue" || issuedUnits(line) > 0) throw Object.assign(new Error("Issued parts require a linked return, not deletion"), { status: 422 });
      if (line.inventoryHoldId) await releaseHold(tx, dealerId, line.inventoryHoldId);
      await tx.delete(jobCardPartsTable).where(and(eq(jobCardPartsTable.id, line.id), eq(jobCardPartsTable.dealerId, dealerId)));
      const breakdown = await buildServiceEstimateBreakdown(tx, card);
      await tx.update(jobCardsTable).set({
        quoteTotal: breakdown.total, estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
        estimateApprovedVersion: null, estimateApprovalAt: null, estimateApprovalEvidence: null,
        quoteApprovedAt: null, ...clearEstimateStaffAcknowledgement,
      }).where(and(eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId)));
      await invalidateServiceEstimate(tx, dealerId, card.id);
    });
    res.status(204).end();
  } catch (error) {
    const failure = error as Error & { status?: number };
    res.status(failure.status ?? 409).json({ error: failure.message });
  }
});

router.get("/job-cards/:id/external-parts", async (req, res): Promise<void> => {
  const params = ListJobCardExternalPartsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(externalJobCardPartsTable)
    .where(
      and(
        eq(externalJobCardPartsTable.jobCardId, params.data.id),
        eq(externalJobCardPartsTable.dealerId, activeDealerId(res)),
      ),
    )
    .orderBy(desc(externalJobCardPartsTable.createdAt));
  res.json(ListJobCardExternalPartsResponse.parse(rows));
});

router.post("/job-cards/:id/parts", async (req, res): Promise<void> => {
  const params = AddJobCardPartParams.safeParse(req.params);
  const parsed = AddJobCardPartBody.extend({
    locationId: z.number().int().positive().optional(),
    binId: z.number().int().positive().nullable().optional(),
  }).safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const kind = parsed.data.kind ?? "issue";
  if (kind === "return") {
    res.status(422).json({
      error: "Operational returns must be recorded through the linked part-credit-note workflow so issued quantity, stock, and financial credit remain reconciled.",
    });
    return;
  }

  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const [existingInvoice] = await db.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable)
    .where(and(eq(serviceInvoicesTable.dealerId, card.dealerId), eq(serviceInvoicesTable.jobCardId, card.id)))
    .limit(1);
  if (existingInvoice) {
    res.status(422).json({ error: "This job has an issued invoice. Use a linked invoice adjustment; do not add or return operational part lines." });
    return;
  }
  let [part] = await db
    .select()
    .from(partsTable)
    .where(
      and(
        eq(partsTable.id, parsed.data.partId),
        eq(partsTable.dealerId, card.dealerId),
      ),
    );
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }
  // Supersession redirect: an old part number transparently resolves to its
  // replacement; obsolete parts with no successor are dead ends.
  if (part.status === "superseded" && part.supersededByPartId != null) {
    const [successor] = await db
      .select()
      .from(partsTable)
      .where(
        and(
          eq(partsTable.id, part.supersededByPartId),
          eq(partsTable.dealerId, card.dealerId),
        ),
      );
    if (successor) part = successor;
  }
  if (part.status === "obsolete") {
    res.status(422).json({
      error: `${part.name} (${part.sku}) is obsolete and cannot be issued`,
    });
    return;
  }

  // Backorder path: an issue that exceeds stock does NOT fail — the line is
  // flagged backordered, the job card goes on hold, and a draft PO is raised.
  let backordered = false;
  let currentPart = part;

  let backorderPoId: number | null = null;
  const [line] = await db.transaction(async (tx) => {
    // Serialize every billable line change with invoice issue and other price
    // mutations before inserting a line or touching stock.
    const [lockedCard] = await tx.select().from(jobCardsTable).where(and(
      eq(jobCardsTable.id, card.id),
      eq(jobCardsTable.dealerId, card.dealerId),
    )).for("update");
    if (!lockedCard || lockedCard.estimateVersion !== card.estimateVersion) {
      throw new Error("job_card_changed");
    }
    if (["cancelled", "closed"].includes(lockedCard.status)) {
      throw Object.assign(new Error("Terminal job cannot reserve parts"), { status: 422 });
    }
    const [invoice] = await tx.select({ id: serviceInvoicesTable.id })
      .from(serviceInvoicesTable)
      .where(and(eq(serviceInvoicesTable.jobCardId, card.id), eq(serviceInvoicesTable.dealerId, card.dealerId)))
      .for("update");
    if (invoice) throw new Error("job_card_invoiced");
    const [lockedPart] = await tx.select().from(partsTable).where(and(
      eq(partsTable.id, currentPart.id),
      eq(partsTable.dealerId, card.dealerId),
    )).for("update");
    if (!lockedPart) throw new Error("Part was removed while adding it to the job card");
    currentPart = lockedPart;
    backordered = currentPart.stock < parsed.data.quantity;
    const inserted = await tx
      .insert(jobCardPartsTable)
      .values({
        dealerId: card.dealerId,
        jobCardId: card.id,
        partId: currentPart.id,
        partName: currentPart.name,
        kind,
        quantity: parsed.data.quantity,
        unitPrice: currentPart.unitPrice,
        unitCost: currentPart.unitCost,
        issuedQuantity: 0,
        inventoryLocationId: parsed.data.locationId,
        inventoryBinId: parsed.data.binId,
        backordered,
      })
      .returning();
    const hold = await reserveJobPart(tx, inserted[0]);
    backordered = hold.backorderRisk;
    inserted[0] = { ...inserted[0], inventoryHoldId: hold.id,
      inventoryLocationId: hold.locationId, inventoryBinId: hold.binId, backordered };
    if (backordered) {
      const shortfall = parsed.data.quantity - currentPart.stock;
      await tx
        .update(jobCardsTable)
        .set({
          status: "on_hold",
          waitingReason: "ordered_parts",
          nextAction: "Await ordered parts",
          timerSeconds: foldedTimerSeconds,
          timerStartedAt: null,
        })
        .where(
          and(
            eq(jobCardsTable.id, card.id),
            eq(jobCardsTable.dealerId, card.dealerId),
          ),
        );
      // Raise a formal PO linked back to the originating job card — receiving
      // it increments stock, fills this backordered line and releases the card.
      const [po] = await tx
        .insert(purchaseOrdersTable)
        .values({
          dealerId: card.dealerId,
          supplierId: currentPart.supplierId,
          status: "ordered",
          reference: `Backorder — job card #${card.id}`,
        })
        .returning();
      await tx.insert(purchaseOrderLinesTable).values({
        dealerId: card.dealerId,
        purchaseOrderId: po.id,
        partId: currentPart.id,
        partName: currentPart.name,
        quantity: Math.max(shortfall, currentPart.reorderLevel),
        unitCost: currentPart.unitCost,
        jobCardId: card.id,
      });
      backorderPoId = po.id;
    }
    // Every operational part change creates a new customer-cost version. The
    // old approval is invalidated in the same transaction as stock/line state,
    // so no reader can invoice the altered work on a stale approval.
    const breakdown = await buildServiceEstimateBreakdown(tx, lockedCard);
    await tx.update(jobCardsTable).set({
      quoteTotal: breakdown.total,
      estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
      estimateApprovedVersion: null,
      estimateApprovalAt: null,
      estimateApprovalEvidence: null,
      quoteApprovedAt: null,
      ...clearEstimateStaffAcknowledgement,
    }).where(and(eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, card.dealerId)))
      .returning();
    await invalidateServiceEstimate(tx, card.dealerId, card.id);
    return inserted;
  });

  // Collision cycle-time pause: a backordered part on a claim's repair order
  // stops the clock until parts arrive (auto-resume on PO receipt or the
  // explicit resume endpoint). Purely a measurement pause — the workshop
  // lifecycle above is untouched (Task 279).
  if (backordered) {
    await db.transaction(async (tx) => {
      const [claim] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.serviceOrderId, card.serviceOrderId),
            eq(collisionClaimsTable.dealerId, card.dealerId),
          ),
        )
        .for("update");
      if (
        claim &&
        claim.pausedAt == null &&
        !["closed", "denied", "total_loss"].includes(claim.status)
      ) {
        await tx
          .update(collisionClaimsTable)
          .set({
          pausedAt: new Date(),
          history: [
            ...claim.history,
            {
              kind: "pause" as const,
              note: `${currentPart.name} backordered — cycle time paused`,
              byUserId: res.locals.user?.id ?? null,
              byName: res.locals.user?.name ?? res.locals.user?.email ?? "System",
              at: new Date().toISOString(),
            },
          ],
          })
          .where(eq(collisionClaimsTable.id, claim.id));
      }
    });
  }

  // MRQ alert: fire only when this issuance CROSSES the reorder threshold.
  if (!backordered && kind === "issue" && issuedUnits(line) > 0) {
    checkLowStockCrossing(
      currentPart,
      currentPart.stock,
      currentPart.stock - parsed.data.quantity,
    );
  }

  // ERPNext: issues/returns are Stock Entries; the backorder path moved no
  // stock but raised a PO that must sync instead.
  if (backorderPoId != null) {
    enqueuePurchaseOrderSync(card.dealerId, backorderPoId, "insert");
  }

  res.status(201).json(AddJobCardPartResponse.parse(line));
});

// ---------------------------------------------------------------------------
// Credit notes (FR-PI-09): returned/unused parts restore stock and reduce the
// job's parts total — internal adjustment only, no cash refund.
// ---------------------------------------------------------------------------

router.get("/job-cards/:id/credit-notes", async (req, res): Promise<void> => {
  const params = ListJobCardCreditNotesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(partCreditNotesTable)
    .where(
      and(
        eq(partCreditNotesTable.jobCardId, params.data.id),
        eq(partCreditNotesTable.dealerId, activeDealerId(res)),
      ),
    )
    .orderBy(desc(partCreditNotesTable.createdAt));
  res.json(ListJobCardCreditNotesResponse.parse(rows));
});

router.post("/job-cards/:id/credit-notes", idempotent("service.part-credit.create"), async (req, res): Promise<void> => {
  const params = CreateJobCardCreditNoteParams.safeParse(req.params);
  const parsed = CreateJobCardCreditNoteBody.extend({
    condition: z.enum(["resalable", "damaged", "scrap"]).default("resalable"),
  }).safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  if (!isServiceApprover(res.locals.user)) {
    res.status(403).json({ error: "Only the Service Manager or Management can issue a part credit note." });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, dealerId),
      ),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  let [line] = await db
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.id, parsed.data.jobCardPartId),
        eq(jobCardPartsTable.jobCardId, card.id),
        eq(jobCardPartsTable.dealerId, dealerId),
      ),
    );
  if (!line || line.kind !== "issue") {
    res.status(404).json({ error: "Issued part line not found on this job card" });
    return;
  }
  if (line.backordered) {
    res.status(422).json({
      error: "This line is still backordered — nothing was issued to credit",
    });
    return;
  }
  const [{ credited }] = await db
    .select({
      credited: sql<number>`coalesce(sum(${partCreditNotesTable.quantity}), 0)::int`,
    })
    .from(partCreditNotesTable)
    .where(
      and(
        eq(partCreditNotesTable.jobCardPartId, line.id),
        eq(partCreditNotesTable.dealerId, dealerId),
      ),
    );
  const remaining = issuedUnits(line) - credited;
  if (parsed.data.quantity > remaining) {
    res.status(422).json({
      error: `Only ${remaining} unit(s) of ${line.partName} left to credit on this line`,
    });
    return;
  }

  let creditFailure: string | null = null;
  let creditInvoice: { id: number; taxAmount: number; grossAmount: number } | null = null;
  const note = await db.transaction(async (tx) => {
    // Lock the card before a credit line or invoice lookup. Invoice issuance
    // takes this same lock, so it cannot commit between return insertion and
    // the financial adjustment decision.
    const [lockedCard] = await tx.select().from(jobCardsTable).where(and(
      eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId),
    )).for("update");
    if (!lockedCard || lockedCard.estimateVersion !== card.estimateVersion) {
      throw new Error("part_credit_card_changed");
    }
    const [lockedLine] = await tx.select().from(jobCardPartsTable).where(and(
      eq(jobCardPartsTable.id, line.id),
      eq(jobCardPartsTable.jobCardId, card.id),
      eq(jobCardPartsTable.dealerId, dealerId),
    )).for("update");
    if (!lockedLine || lockedLine.kind !== "issue" || lockedLine.backordered) {
      throw new Error("part_credit_line_changed");
    }
    line = lockedLine;
    const [invoice] = await tx.select().from(serviceInvoicesTable).where(and(
      eq(serviceInvoicesTable.jobCardId, card.id),
      eq(serviceInvoicesTable.dealerId, dealerId),
    )).for("update");
    // Serialize partial credits per original issue line. This lock makes the
    // remaining-quantity check authoritative under concurrent requests.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`part-credit-${dealerId}-${line.id}`}))`);
    const [{ credited: currentCredited }] = await tx.select({
      credited: sql<number>`coalesce(sum(${partCreditNotesTable.quantity}), 0)::int`,
    }).from(partCreditNotesTable).where(and(
      eq(partCreditNotesTable.jobCardPartId, line.id),
      eq(partCreditNotesTable.dealerId, dealerId),
    ));
    if (parsed.data.quantity > issuedUnits(lockedLine) - currentCredited) {
      throw new Error("part_credit_quantity_conflict");
    }
    const [inserted] = await tx
      .insert(partCreditNotesTable)
      .values({
        dealerId,
        jobCardId: card.id,
        jobCardPartId: line.id,
        partId: line.partId,
        partName: line.partName,
        quantity: parsed.data.quantity,
        unitPrice: line.unitPrice,
        amount:
          Math.round(line.unitPrice * parsed.data.quantity * 100) / 100,
        reason: parsed.data.reason,
        condition: parsed.data.condition,
        createdBy: res.locals.user?.name ?? null,
      })
      .returning();
    // The paired return line restores stock and is what reduces the job's
    // parts total (and any invoice issued later) — it also shows in history.
    await tx.insert(jobCardPartsTable).values({
      dealerId,
      jobCardId: card.id,
      partId: line.partId,
      partName: line.partName,
      kind: "return",
      quantity: parsed.data.quantity,
      unitPrice: line.unitPrice,
      unitCost: line.unitCost,
      backordered: false,
    });
    const movement = await moveStock(tx, {
      dealerId, partId: line.partId, locationId: line.inventoryLocationId ?? undefined,
      binId: line.inventoryBinId, type: "return", quantityDelta: parsed.data.quantity,
      nonSellableDelta: parsed.data.condition === "resalable" ? 0 : parsed.data.quantity,
      unitCost: line.unitCost, referenceType: "part_credit_note", referenceId: String(inserted.id),
      idempotencyKey: `part-return:${dealerId}:${inserted.id}`,
    });
    await tx.update(partCreditNotesTable).set({ inventoryTransactionId: movement.id })
      .where(and(eq(partCreditNotesTable.id, inserted.id), eq(partCreditNotesTable.dealerId, dealerId)));
    inserted.inventoryTransactionId = movement.id;
    const creditAmount = Math.round(line.unitPrice * parsed.data.quantity * 100) / 100;
    // The operational return and the financial credit are intentionally
    // separate. An issued document remains immutable in its line totals; its
    // outstanding amount changes through an auditable adjustment only.
    if (invoice) {
      if (invoice.status === "void") throw new Error("part_credit_void_invoice");
      const [collision] = await tx.select({ id: collisionClaimsTable.id })
        .from(collisionClaimsTable)
        .where(and(
          eq(collisionClaimsTable.serviceInvoiceId, invoice.id),
          eq(collisionClaimsTable.dealerId, dealerId),
        ));
      const taxableBase = invoice.partsTotal + invoice.laborTotal + invoice.surchargeTotal;
      const taxCredit = taxableBase > 0
        ? Math.round((creditAmount * invoice.tax / taxableBase) * 100) / 100
        : 0;
      const grossCredit = creditAmount + taxCredit;
      // Discounts and earlier credits can make the original part value larger
      // than the amount ever collectible/refundable. Reject rather than clip:
      // clipping would leave stock history and ERP credit amounts dishonest.
      const priorAdjustments = (invoice.adjustments ?? []).reduce(
        (sum, adjustment) => sum + adjustment.amount,
        0,
      );
      const financialRemaining = invoice.status === "issued"
        ? Math.max(0, invoice.balance)
        : Math.max(0, invoice.total + priorAdjustments);
      if (grossCredit > financialRemaining + 0.005) {
        throw new Error("part_credit_financial_overage");
      }
      creditInvoice = { id: invoice.id, taxAmount: taxCredit, grossAmount: grossCredit };
      const adjustment = {
        amount: -grossCredit,
        reason: `Part credit #${inserted.id}: ${line.partName} — ${parsed.data.reason} (tax credit GY$${taxCredit.toFixed(2)})`,
        by: res.locals.user?.name ?? res.locals.user?.email ?? "Staff",
        at: new Date().toISOString(),
      };
      await tx.update(serviceInvoicesTable).set({
        adjustments: [...(invoice.adjustments ?? []), adjustment],
        // A paid invoice receives account credit rather than an automatic cash
        // refund. Collision credits are explicitly held for the claim
        // settlement allocator; neither silently rewrites paid/split balances.
        ...(invoice.status === "issued" && !collision ? {
          total: sql`greatest(0, ${serviceInvoicesTable.total} - ${grossCredit})`,
          balance: sql`greatest(0, ${serviceInvoicesTable.balance} - ${grossCredit})`,
        } : {}),
        ...(invoice.status === "paid" && !collision ? {
          customerCreditBalance: sql`${serviceInvoicesTable.customerCreditBalance} + ${grossCredit}`,
        } : {}),
        ...(collision ? {
          creditReconciliationStatus: "pending_collision_settlement",
        } : {}),
      }).where(and(eq(serviceInvoicesTable.id, invoice.id), eq(serviceInvoicesTable.dealerId, dealerId)));
    }
    // Every return immediately updates the live net parts and quote total.
    // The issued invoice retains its immutable original totals and is changed
    // only through the linked adjustment above. Post-invoice credits must not,
    // however, reopen terminal operational work.
    const revisedBreakdown = await buildServiceEstimateBreakdown(tx, lockedCard);
    await tx.update(jobCardsTable).set({
      quoteTotal: revisedBreakdown.total,
      estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
      estimateApprovedVersion: null,
      estimateApprovalAt: null,
      estimateApprovalEvidence: null,
      quoteApprovedAt: null,
      ...clearEstimateStaffAcknowledgement,
    }).where(and(eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId)));
    await invalidateServiceEstimate(tx, dealerId, card.id);
    return inserted;
    // (ERPNext Material Receipt for this return is enqueued after commit.)
  }).catch((error) => {
    if (error instanceof Error && [
      "part_credit_quantity_conflict",
      "part_credit_card_changed",
      "part_credit_line_changed",
    ].includes(error.message)) return null;
    if (error instanceof Error && ["part_credit_void_invoice", "part_credit_financial_overage"].includes(error.message)) {
      creditFailure = error.message;
      return null;
    }
    throw error;
  });
  if (!note) {
    const messages: Record<string, string> = {
      part_credit_void_invoice: "A void invoice cannot receive a part credit.",
      part_credit_financial_overage: "This return exceeds the invoice amount remaining after discounts and earlier credits.",
    };
    res.status(creditFailure ? 422 : 409).json({
      error: creditFailure ? messages[creditFailure] : "This part line was credited by another request — reload and retry.",
    });
    return;
  }
  const [restockedPart] = await db
    .select()
    .from(partsTable)
    .where(and(eq(partsTable.id, line.partId), eq(partsTable.dealerId, dealerId)));
  if (restockedPart) {
    checkLowStockCrossing(restockedPart, restockedPart.stock, restockedPart.stock);
  }

  // ERPNext: the credited return restores stock → Material Receipt.
  enqueueStockEntrySync({
    dealerId,
    partId: line.partId,
    qty: parsed.data.quantity,
    direction: "in",
    entityType: "part_credit_note",
    entityId: note.id,
    remark: `AURA job card #${card.id} — ${parsed.data.condition} credit note return (${line.partName}); financial credit is stock-neutral`,
    dedupeKey: `erp:se:credit:${dealerId}:${note.id}`,
  });
  const syncedCredit = creditInvoice as { id: number; taxAmount: number; grossAmount: number } | null;
  if (syncedCredit) {
    queueServiceInvoiceCreditSync({
      dealerId,
      serviceInvoiceId: syncedCredit.id,
      creditNoteId: note.id,
      netAmount: note.amount,
      taxAmount: syncedCredit.taxAmount,
      grossAmount: syncedCredit.grossAmount,
    });
  }

  res.status(201).json(CreateJobCardCreditNoteResponse.parse(note));
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Compute totals and issue the invoice for a job card. Shared by the manual
 * "Generate invoice" endpoint and the automatic issue-on-completion path.
 * Fires the customer invoice email (deduped per invoice) on success.
 */
async function issueServiceInvoice(
  card: JobCard,
): Promise<
  | { ok: true; invoice: ServiceInvoice }
  | { ok: false; status: number; error: string }
> {
  if (card.status !== "completed") {
    return {
      ok: false,
      status: 422,
      error: "Complete the job card before issuing its service invoice.",
    };
  }
  const [existing] = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.jobCardId, card.id),
        eq(serviceInvoicesTable.dealerId, card.dealerId),
      ),
    );
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: `Invoice #${existing.id} already exists for this job card`,
    };
  }
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, card.serviceOrderId),
        eq(serviceOrdersTable.dealerId, card.dealerId),
      ),
    );
  if (!order) {
    return { ok: false, status: 404, error: "Service order not found" };
  }

  // Collision claims gate invoicing on insurer sign-off: the invoice defines
  // the insurer/deductible split, so it cannot be issued before the insurer
  // has signed off on the completed repair (Task 279).
  const [claim] = await db
    .select()
    .from(collisionClaimsTable)
    .where(
      and(
        eq(collisionClaimsTable.serviceOrderId, order.id),
        eq(collisionClaimsTable.dealerId, order.dealerId),
      ),
    );
  if (claim && !["insurer_signoff", "invoiced"].includes(claim.status)) {
    return {
      ok: false,
      status: 422,
      error:
        "This repair has a collision claim awaiting insurer sign-off — the claim must reach Insurer Sign-off before invoicing",
    };
  }
  if (claim) {
    const [pendingSupplement] = await db
      .select({ id: collisionSupplementsTable.id })
      .from(collisionSupplementsTable)
      .where(
        and(
          eq(collisionSupplementsTable.claimId, claim.id),
          eq(collisionSupplementsTable.dealerId, claim.dealerId),
          eq(collisionSupplementsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (pendingSupplement) {
      return {
        ok: false,
        status: 422,
        error:
          "Decide all pending collision supplements before generating the invoice",
      };
    }
  }

  const lines = await db
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.jobCardId, card.id),
        eq(jobCardPartsTable.dealerId, card.dealerId),
      ),
    );
  const internalPartsTotal = lines.reduce(
    (sum, l) =>
      sum + l.unitPrice * l.quantity * (l.kind === "return" ? -1 : 1),
    0,
  );
  const externalLines = await db
    .select()
    .from(externalJobCardPartsTable)
    .where(
      and(
        eq(externalJobCardPartsTable.jobCardId, card.id),
        eq(externalJobCardPartsTable.dealerId, card.dealerId),
      ),
    );
  const externalPartsTotal = externalLines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0,
  );
  const partsTotal = internalPartsTotal + externalPartsTotal;
  const laborTotal =
    effectiveQuotedLaborHours(card.quotedLaborHours, card.laborHours) *
    card.laborRate;
  // A suggested-but-undecided surcharge blocks invoicing: staff must apply
  // or waive it so the decision is on record before totals lock.
  if (card.surchargeStatus === "suggested") {
    return {
      ok: false,
      status: 422,
      error:
        "Late-service surcharge is still undecided — apply or waive it before invoicing",
    };
  }
  const surchargeTotal =
    card.surchargeStatus === "applied" ? card.surchargeAmount : 0;
  // Deterministic tax engine: same per-dealer configured rules as sales
  // quotes (dealer_taxes VAT rule) — no hardcoded rate.
  const taxRules = await ensureDealerTaxes(card.dealerId);
  const { tax, total } = computeServiceTax(
    Math.round((partsTotal + laborTotal + surchargeTotal) * 100) / 100,
    taxRules,
  );
  if (claim && total <= 0) {
    return {
      ok: false,
      status: 422,
      error:
        "Cannot issue a zero-value collision invoice — add the final parts, labour, or approved invoice adjustment before invoicing",
    };
  }
  if (!hasCurrentChargeableWorkAuthorization(card)) {
    return {
      ok: false,
      status: 422,
      error:
        "Customer approval and service staff acknowledgement are required for the current estimate version before an invoice can be issued.",
    };
  }

  // Issue + collision binding in ONE transaction with the claim row locked
  // FOR UPDATE: the invoice can never exist while the split stamping loses a
  // race to a concurrent claim transition — if the stamp cannot apply, the
  // whole issue rolls back.
  let issued: ServiceInvoice | undefined;
  let stockIssues: Awaited<ReturnType<typeof issueJobParts>> = [];
  try {
    issued = await db.transaction(async (tx) => {
      // This is the serialization point shared with all billable-part and
      // quote mutations. A caller's pre-transaction snapshot is never enough
      // to issue against a changed estimate.
      const [lockedCard] = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.id, card.id),
        eq(jobCardsTable.dealerId, card.dealerId),
      )).for("update");
      if (
        !lockedCard ||
        lockedCard.status !== "completed" ||
        lockedCard.estimateVersion !== card.estimateVersion ||
        !hasCurrentChargeableWorkAuthorization(lockedCard)
      ) {
        throw Object.assign(new Error("estimate-version-changed"), { issueCode: 409 });
      }
      if (lockedCard.surchargeStatus === "suggested") {
        throw Object.assign(new Error("surcharge-undecided"), { issueCode: 422 });
      }
      const lockedBreakdown = await buildServiceEstimateBreakdown(tx, lockedCard);
      if (Math.abs(lockedCard.quoteTotal - lockedBreakdown.total) > 0.005) {
        throw Object.assign(new Error("estimate-total-mismatch"), { issueCode: 409 });
      }
      // Serialize against collision-claim intake on the shared repair order,
      // then re-read the claim after the lock. This closes the "both observed
      // no row" race between normal invoicing and claim creation.
      const [lockedOrder] = await tx
        .select({ id: serviceOrdersTable.id })
        .from(serviceOrdersTable)
        .where(
          and(
            eq(serviceOrdersTable.id, order.id),
            eq(serviceOrdersTable.dealerId, order.dealerId),
          ),
        )
        .for("update");
      if (!lockedOrder) {
        throw Object.assign(new Error("service-order-missing"), {
          issueCode: 404,
        });
      }
      const [lockedClaim] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.serviceOrderId, lockedOrder.id),
            eq(collisionClaimsTable.dealerId, order.dealerId),
          ),
        )
        .for("update");
      if (lockedClaim) {
        // Only an exactly insurer_signoff claim with no bound invoice may be
        // invoiced: a concurrent issue that already stamped the claim leaves
        // it invoiced/bound, and this second attempt must not create an
        // unbound duplicate receivable.
        if (
          !lockedClaim ||
          lockedClaim.status !== "insurer_signoff" ||
          lockedClaim.serviceInvoiceId != null
        ) {
          const code =
            lockedClaim &&
            (lockedClaim.status === "invoiced" ||
              lockedClaim.serviceInvoiceId != null)
              ? 409
              : 422;
          throw Object.assign(new Error("collision-gate"), { issueCode: code });
        }
        const [pendingSupplement] = await tx
          .select({ id: collisionSupplementsTable.id })
          .from(collisionSupplementsTable)
          .where(
            and(
              eq(collisionSupplementsTable.claimId, lockedClaim.id),
              eq(collisionSupplementsTable.dealerId, lockedClaim.dealerId),
              eq(collisionSupplementsTable.status, "pending"),
            ),
          )
          .limit(1);
        if (pendingSupplement) {
          throw Object.assign(new Error("pending-supplements"), {
            issueCode: 422,
          });
        }
      }
      // Re-check the one-invoice-per-job-card invariant AFTER taking the
      // claim lock: two concurrent issues both pass the pre-transaction
      // check, but the loser serializes behind the winner here and bails
      // without inserting. The service_invoices_job_card_unique DB index
      // backstops the non-collision path.
      const [dupe] = await tx
        .select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(
          and(
            eq(serviceInvoicesTable.jobCardId, card.id),
            eq(serviceInvoicesTable.dealerId, card.dealerId),
          ),
        );
      if (dupe) {
        throw Object.assign(new Error("invoice-exists"), { issueCode: 409 });
      }
      // The invoice and all previously unissued physical parts commit together.
      // Historical null issuedQuantity lines are already issued, not new demand.
      try {
        stockIssues = await issueJobParts(tx, card.dealerId, card.id);
      } catch (error) {
        throw Object.assign(new Error(`Parts issue failed: ${(error as Error).message}`), { stockIssue: true });
      }
      const [created] = await tx
        .insert(serviceInvoicesTable)
        .values({
          dealerId: order.dealerId,
          serviceOrderId: order.id,
          jobCardId: card.id,
          customerId: order.customerId,
          customerName: order.customerName,
          vehicleInfo: order.vehicleInfo,
          partsTotal: lockedBreakdown.internalPartsTotal + lockedBreakdown.externalPartsTotal,
          externalPartsTotal: lockedBreakdown.externalPartsTotal,
          laborTotal: lockedBreakdown.labourTotal,
          surchargeTotal: lockedBreakdown.surchargeTotal,
          tax: lockedBreakdown.tax,
          total: lockedBreakdown.total,
          originalTotal: lockedBreakdown.total,
          balance: lockedBreakdown.total,
          status: "issued",
          // Snapshot the hours from the locked estimate. Daily reporting never
          // derives historical invoice hours from mutable card values or money.
          invoicedLaborHours: effectiveQuotedLaborHours(
            lockedCard.quotedLaborHours,
            lockedCard.laborHours,
          ),
          invoicedLaborHoursSource: "estimate_snapshot",
          issuedAt: new Date(),
          // Totals lock at issue (FR-SR-09); discount approval and the
          // adjustment endpoint are the only sanctioned paths that change them.
          lockedAt: new Date(),
        })
        .returning();

      // Stamp the collision split on the claim: the customer owes the
      // deductible (capped at the invoice total); the insurer owes the rest.
      // The claim auto-advances insurer_signoff → invoiced with an audit event.
      if (created && lockedClaim && lockedClaim.status === "insurer_signoff") {
        const deductibleDue =
          Math.round(Math.min(lockedClaim.deductible, created.total) * 100) /
          100;
        const insurerDue =
          Math.round((created.total - deductibleDue) * 100) / 100;
        const [stamped] = await tx
          .update(collisionClaimsTable)
          .set({
            status: "invoiced",
            serviceInvoiceId: created.id,
            insurerDue,
            deductibleDue,
            history: [
              ...lockedClaim.history,
              {
                kind: "status" as const,
                from: "insurer_signoff",
                to: "invoiced",
                note: `Invoice #${created.id} issued — insurer ${insurerDue.toFixed(2)}, deductible ${deductibleDue.toFixed(2)}`,
                byUserId: null,
                byName: "System",
                at: new Date().toISOString(),
              },
            ],
          })
          .where(
            and(
              eq(collisionClaimsTable.id, lockedClaim.id),
              eq(collisionClaimsTable.dealerId, lockedClaim.dealerId),
              eq(collisionClaimsTable.status, "insurer_signoff"),
            ),
          )
          .returning();
        // Row is locked, so a miss means something is deeply wrong — roll the
        // invoice back rather than leave it unbound.
        if (!stamped) {
          throw Object.assign(new Error("collision-race"), { issueCode: 409 });
        }
      }
      return created;
    });
  } catch (err) {
    if ((err as { stockIssue?: boolean }).stockIssue) {
      return { ok: false, status: 409, error: (err as Error).message };
    }
    const code = (err as { issueCode?: number }).issueCode;
    if (code === 404) {
      return { ok: false, status: 404, error: "Service order not found" };
    }
    if (code === 422) {
      return {
        ok: false,
        status: 422,
        error:
          (err as Error).message === "pending-supplements"
            ? "Decide all pending collision supplements before generating the invoice"
            : "This repair has a collision claim awaiting insurer sign-off — the claim must reach Insurer Sign-off before invoicing",
      };
    }
    if (code === 409) {
      return {
        ok: false,
        status: 409,
        error:
          (err as Error).message === "invoice-exists"
            ? "An invoice already exists for this job card"
            : "This repair's collision claim is already invoiced",
      };
    }
    // DB unique backstop (service_invoices_job_card_unique) for concurrent
    // issues that slipped past every check — drizzle wraps pg in err.cause.
    const pg = err as { code?: string; cause?: { code?: string } };
    if (pg?.code === "23505" || pg?.cause?.code === "23505") {
      return {
        ok: false,
        status: 409,
        error: "An invoice already exists for this job card",
      };
    }
    throw err;
  }
  const invoice = issued;
  for (const line of stockIssues) {
    checkLowStockCrossing(line.part, line.part.stock, line.part.stock - line.quantity);
    enqueueStockEntrySync({
    dealerId: card.dealerId, partId: line.partId, qty: line.quantity, direction: "out",
    entityType: "job_card_part", entityId: line.id,
    remark: `AURA job card #${card.id} — invoice part issue`,
    dedupeKey: `erp:se:jcp:${card.dealerId}:${line.id}`,
  });
  }

  // Snapshot the issued financial document, never its subsequently mutable
  // job card. ERPNext uses this original mapping as the only return-against
  // target for later service credits.
  if (invoice) {
    const issuedLines = [
      ...(invoice.partsTotal > 0 ? [{ description: "Parts", amount: Math.round(invoice.partsTotal * 100) / 100 }] : []),
      ...(invoice.laborTotal > 0 ? [{ description: "Labour", amount: Math.round(invoice.laborTotal * 100) / 100 }] : []),
      ...(invoice.surchargeTotal > 0 ? [{ description: "Service surcharge", amount: Math.round(invoice.surchargeTotal * 100) / 100 }] : []),
    ];
    queueServiceInvoiceSync({
      dealerId: invoice.dealerId,
      serviceInvoiceId: invoice.id,
      customerId: invoice.customerId ?? null,
      customerName: invoice.customerName ?? "Walk-in customer",
      vehicleInfo: invoice.vehicleInfo,
      originalTotal: invoice.originalTotal,
      tax: invoice.tax,
      issuedAt: invoice.createdAt,
      lines: issuedLines,
    });
  }
  // FR-COM: customer gets the invoice PDF by email (deduped per invoice).
  if (invoice) onServiceInvoiceIssued(invoice);
  if (invoice && claim) {
    coordinateCollisionClaim({
      id: claim.id,
      dealerId: claim.dealerId,
      vehicleInfo: claim.vehicleInfo,
      status: "invoiced",
      event: "status",
      eventKey: "status:insurer_signoff:invoiced",
      detail: `Invoice #${invoice.id} generated; insurer and deductible collection can begin.`,
    });
  }

  return { ok: true, invoice };
}

router.post("/job-cards/:id/invoice", async (req, res): Promise<void> => {
  const params = CreateJobCardInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const result = await issueServiceInvoice(card);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(CreateJobCardInvoiceResponse.parse(result.invoice));
});

router.get("/service-invoices", async (req, res): Promise<void> => {
  const query = ListServiceInvoicesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.dealerId, activeDealerId(res)),
        query.data.status
          ? eq(serviceInvoicesTable.status, query.data.status)
          : undefined,
      ),
    )
    .orderBy(desc(serviceInvoicesTable.createdAt));
  res.json(ListServiceInvoicesResponse.parse(rows));
});

router.patch("/service-invoices/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceInvoiceParams.safeParse(req.params);
  const parsed = UpdateServiceInvoiceBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  // Locked totals (FR-SR-09): PATCH only ever touches lifecycle status and
  // the signed-copy acknowledgement — monetary fields are not accepted here.
  const dealerId = activeDealerId(res);
  const { signedCopyFiled, status, paymentMethod, paymentReference } = parsed.data;
  if (status === "paid" && !paymentMethod) {
    res.status(422).json({ error: "Choose how payment was received before marking this invoice paid" });
    return;
  }
  if (status !== "paid" && (paymentMethod || paymentReference)) {
    res.status(422).json({ error: "Payment details are only accepted when marking an invoice paid" });
    return;
  }
  // One transaction with the invoice row locked FOR UPDATE: the collision
  // advance route locks the same row before binding it to a claim, so a
  // manual void can never slip in between "claim reads issued invoice" and
  // "claim binds it" — one of the two serializes behind the other.
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(serviceInvoicesTable)
      .where(
        and(
          eq(serviceInvoicesTable.id, params.data.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      )
      .for("update");
    if (!current) return { code: 404 as const, error: "Invoice not found" };
    // Irreversible lifecycle: issued → paid | void only. Paid and void are
    // terminal — a paid invoice can never be reopened into an adjustable state.
    if (status !== undefined && status !== current.status) {
      const allowed =
        current.status === "issued" && (status === "paid" || status === "void");
      if (!allowed) {
        return {
          code: 422 as const,
          error: `Invalid status transition ${current.status} → ${status}; paid and void invoices are final`,
        };
      }
    }
    if (signedCopyFiled !== undefined && current.status === "void") {
      return {
        code: 422 as const,
        error: "Cannot record acknowledgements on a void invoice",
      };
    }
    // Collision-claim invoices settle through the split receivable (insurer +
    // deductible settlements), not a manual flip: paid requires both shares
    // collected, and void is blocked outright while a live claim exists on
    // this repair — linked already or still awaiting binding (Task 279).
    if (status !== undefined && status !== current.status) {
      const [claim] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.serviceOrderId, current.serviceOrderId),
            eq(collisionClaimsTable.dealerId, dealerId),
          ),
        );
      if (
        claim &&
        (claim.serviceInvoiceId === current.id ||
          !["denied", "total_loss", "closed"].includes(claim.status))
      ) {
        if (status === "void") {
          return {
            code: 422 as const,
            error:
              "Cannot void a collision-claim invoice — resolve it through the claim (denied / total loss) instead",
          };
        }
        const [sums] = await tx
          .select({
            insurerPaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'insurer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
            deductiblePaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'customer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
          })
          .from(collisionSettlementsTable)
          .where(
            and(
              eq(collisionSettlementsTable.claimId, claim.id),
              eq(collisionSettlementsTable.dealerId, dealerId),
            ),
          );
        if (
          status === "paid" &&
          (claim.serviceInvoiceId !== current.id ||
            (sums?.insurerPaid ?? 0) < (claim.insurerDue ?? 0) - 0.005 ||
            (sums?.deductiblePaid ?? 0) < (claim.deductibleDue ?? 0) - 0.005)
        ) {
          return {
            code: 422 as const,
            error:
              "This invoice belongs to a collision claim — record the insurer and deductible settlements on the claim; it flips to paid automatically once both are collected",
          };
        }
      }
    }
    const patch: Partial<typeof serviceInvoicesTable.$inferInsert> = {};
    if (status !== undefined) patch.status = status;
    if (status === "paid") {
      patch.paymentMethod = paymentMethod!;
      patch.paymentReference = paymentReference?.trim() || null;
      patch.paidBy = res.locals.user?.name ?? res.locals.user?.email ?? "Staff";
      patch.paidAt = new Date();
      patch.balance = 0;
    }
    if (signedCopyFiled) {
      patch.signedCopyFiledBy =
        res.locals.user?.name ?? res.locals.user?.email ?? "Staff";
      patch.signedCopyFiledAt = new Date();
    } else if (signedCopyFiled === false) {
      patch.signedCopyFiledBy = null;
      patch.signedCopyFiledAt = null;
    }
    if (Object.keys(patch).length === 0) {
      return { code: 200 as const, invoice: current };
    }
    const [invoice] = await tx
      .update(serviceInvoicesTable)
      .set(patch)
      .where(
        and(
          eq(serviceInvoicesTable.id, current.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      )
      .returning();
    return { code: 200 as const, invoice: invoice! };
  });
  if (outcome.code !== 200) {
    res.status(outcome.code).json({ error: outcome.error });
    return;
  }
  res.json(UpdateServiceInvoiceResponse.parse(outcome.invoice));
});

// ---------------------------------------------------------------------------
// Discount approval workflow (FR-SR-08)
// ---------------------------------------------------------------------------

router.post(
  "/service-invoices/:id/discount",
  async (req, res): Promise<void> => {
    const params = RequestServiceInvoiceDiscountParams.safeParse(req.params);
    const parsed = RequestServiceInvoiceDiscountBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const [invoice] = await db
      .select()
      .from(serviceInvoicesTable)
      .where(
        and(
          eq(serviceInvoicesTable.id, params.data.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      );
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const [collisionClaim] = await db
      .select({ id: collisionClaimsTable.id })
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.serviceInvoiceId, invoice.id),
          eq(collisionClaimsTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (collisionClaim) {
      res.status(422).json({
        error:
          "Collision invoice totals are locked to the insurer/deductible split; use the claim supplement and settlement workflow",
      });
      return;
    }
    if (invoice.status !== "issued") {
      res.status(422).json({
        error: `Discounts can only be requested on issued invoices (this one is ${invoice.status})`,
      });
      return;
    }
    if (invoice.discountStatus === "pending") {
      res.status(422).json({ error: "A discount request is already pending" });
      return;
    }
    if (invoice.discountStatus === "approved") {
      res.status(422).json({ error: "A discount has already been approved" });
      return;
    }
    // The balance is the only collectible amount after prior returns/credits;
    // immutable original component totals are not a discount authority.
    if (parsed.data.amount > Math.max(0, invoice.balance)) {
      res.status(422).json({
        error: "Discount cannot exceed the invoice total",
      });
      return;
    }
    const [updated] = await db
      .update(serviceInvoicesTable)
      .set({
        discountStatus: "pending",
        discountRequestedAmount: parsed.data.amount,
        discountReason: parsed.data.reason ?? null,
        discountRequestedBy:
          res.locals.user?.name ?? res.locals.user?.email ?? "Staff",
        discountRequestedAt: new Date(),
        discountDecidedBy: null,
        discountDecidedAt: null,
      })
      .where(
        and(
          eq(serviceInvoicesTable.id, invoice.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
          eq(serviceInvoicesTable.status, "issued"),
          eq(serviceInvoicesTable.discountStatus, invoice.discountStatus),
          gte(serviceInvoicesTable.balance, parsed.data.amount),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Invoice balance or discount state changed — reload and retry." });
      return;
    }
    const managerIds = await generalManagers(dealerId);
    if (managerIds.length) {
      const dueDate = zonedDayKey(new Date(), await dealerTimezone(dealerId));
      await db.insert(tasksTable).values(
        managerIds.map((managerId) => ({
          dealerId,
          title: `Approve discount · Invoice #${updated.id}`,
          description: `GYD ${parsed.data.amount.toLocaleString()}${parsed.data.reason ? ` · ${parsed.data.reason}` : ""}`,
          assigneeUserId: managerId,
          createdByUserId: res.locals.user?.id ?? null,
          dueDate,
          kind: "service_discount_approval",
          priority: "high",
        })),
      );
    }
    res.json(RequestServiceInvoiceDiscountResponse.parse(updated));
  },
);

router.post(
  "/service-invoices/:id/discount/decision",
  async (req, res): Promise<void> => {
    const params = DecideServiceInvoiceDiscountParams.safeParse(req.params);
    const parsed = DecideServiceInvoiceDiscountBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const user = res.locals.user;
    if (!isServiceApprover(user)) {
      res.status(403).json({
        error: "Only the Service Manager or Management can decide discounts",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const [invoice] = await db
      .select()
      .from(serviceInvoicesTable)
      .where(
        and(
          eq(serviceInvoicesTable.id, params.data.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      );
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const [collisionClaim] = await db
      .select({ id: collisionClaimsTable.id })
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.serviceInvoiceId, invoice.id),
          eq(collisionClaimsTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (collisionClaim) {
      res.status(422).json({
        error:
          "Collision invoice totals are locked to the insurer/deductible split; use the claim supplement and settlement workflow",
      });
      return;
    }
    if (invoice.discountStatus !== "pending") {
      res.status(422).json({ error: "No pending discount on this invoice" });
      return;
    }
    const approve = parsed.data.action === "approve";
    const requested = invoice.discountRequestedAmount ?? 0;
    // A prior return/credit may already have reduced the collectible balance.
    // Never recreate the pre-credit amount from immutable component totals.
    const discount = approve
      ? Math.min(requested, Math.max(0, invoice.balance))
      : 0;
    const [updated] = await db
      .update(serviceInvoicesTable)
      .set({
        discountStatus: approve ? "approved" : "rejected",
        discountTotal: discount,
        discountDecidedBy: user?.name ?? user?.email ?? "Manager",
        discountDecidedAt: new Date(),
        ...(approve
          ? {
              total: Math.max(0, Math.round((invoice.total - discount) * 100) / 100),
              balance: Math.max(0, Math.round((invoice.balance - discount) * 100) / 100),
            }
          : {}),
      })
      .where(
        and(
          eq(serviceInvoicesTable.id, invoice.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
          eq(serviceInvoicesTable.discountStatus, "pending"),
          eq(serviceInvoicesTable.status, "issued"),
          eq(serviceInvoicesTable.total, invoice.total),
          eq(serviceInvoicesTable.balance, invoice.balance),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Invoice discount state changed — reload and retry." });
      return;
    }
    await db
      .update(tasksTable)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(tasksTable.dealerId, dealerId),
          eq(tasksTable.kind, "service_discount_approval"),
          eq(tasksTable.title, `Approve discount · Invoice #${invoice.id}`),
          eq(tasksTable.status, "open"),
        ),
      );
    res.json(DecideServiceInvoiceDiscountResponse.parse(updated));
  },
);

// ---------------------------------------------------------------------------
// Post-issue adjustments (FR-SR-09): the only way locked totals change
// ---------------------------------------------------------------------------

router.post("/service-invoices/:id/adjust", async (req, res): Promise<void> => {
  const params = AdjustServiceInvoiceParams.safeParse(req.params);
  const parsed = AdjustServiceInvoiceBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [invoice] = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.id, params.data.id),
        eq(serviceInvoicesTable.dealerId, dealerId),
      ),
    );
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const [collisionClaim] = await db
    .select({ id: collisionClaimsTable.id })
    .from(collisionClaimsTable)
    .where(
      and(
        eq(collisionClaimsTable.serviceInvoiceId, invoice.id),
        eq(collisionClaimsTable.dealerId, dealerId),
      ),
    )
    .limit(1);
  if (collisionClaim) {
    res.status(422).json({
      error:
        "Collision invoice totals are locked to the insurer/deductible split; use the claim supplement and settlement workflow",
    });
    return;
  }
  // Adjustments change a locked financial record, so they are restricted to
  // Service Manager / Management — not the standard service:create grant.
  if (!isServiceApprover(res.locals.user)) {
    res.status(403).json({
      error: "Only the Service Manager or Management can record adjustments",
    });
    return;
  }
  if (invoice.status !== "issued") {
    res.status(422).json({
      error:
        invoice.status === "paid"
          ? "Invoice is already paid — settle differences through a credit note, not an adjustment"
          : "Cannot adjust a void invoice",
    });
    return;
  }
  const entry = {
    amount: Math.round(parsed.data.amount * 100) / 100,
    reason: parsed.data.reason,
    by: res.locals.user?.name ?? res.locals.user?.email ?? "Staff",
    at: new Date().toISOString(),
  };
  const nextTotal = Math.round((invoice.total + entry.amount) * 100) / 100;
  const nextBalance = Math.round((invoice.balance + entry.amount) * 100) / 100;
  if (nextTotal < 0 || nextBalance < 0) {
    res.status(422).json({ error: "Adjustment would make the total or outstanding balance negative" });
    return;
  }
  // Conditional on status + unchanged total so a concurrent adjustment or
  // payment can't be silently overwritten; the loser gets a 409 to retry.
  const [updated] = await db
    .update(serviceInvoicesTable)
    .set({
      adjustments: [...(invoice.adjustments ?? []), entry],
      total: nextTotal,
      balance: nextBalance,
    })
    .where(
      and(
        eq(serviceInvoicesTable.id, invoice.id),
        eq(serviceInvoicesTable.dealerId, dealerId),
        eq(serviceInvoicesTable.status, "issued"),
        eq(serviceInvoicesTable.total, invoice.total),
        eq(serviceInvoicesTable.balance, invoice.balance),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({
      error: "Invoice changed while recording the adjustment — reload and retry",
    });
    return;
  }
  res.json(AdjustServiceInvoiceResponse.parse(updated));
});

router.get(
  "/service-invoices/:id/receipt-pdf",
  async (req, res): Promise<void> => {
    const params = UpdateServiceInvoiceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [invoice] = await db
      .select()
      .from(serviceInvoicesTable)
      .where(
        and(
          eq(serviceInvoicesTable.id, params.data.id),
          eq(serviceInvoicesTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!invoice) {
      res.status(404).json({ error: "Service invoice not found" });
      return;
    }
    const pdf = await buildServiceReceiptPdf(
      invoice,
      await dealerTimezone(invoice.dealerId),
      await getDealerPdfBranding(invoice.dealerId),
    );
    res
      .setHeader("Content-Type", "application/pdf")
      .setHeader(
        "Content-Disposition",
        `inline; filename="SR-${String(invoice.id).padStart(5, "0")}-receipt.pdf"`,
      )
      .send(pdf);
  },
);

router.get("/service-invoices/:id/pdf", async (req, res): Promise<void> => {
  const params = UpdateServiceInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [invoice] = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.id, params.data.id),
        eq(serviceInvoicesTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!invoice) {
    res.status(404).json({ error: "Service invoice not found" });
    return;
  }
  const rate = await dealerExchangeRate(invoice.dealerId);
  const pdf = await buildServiceInvoicePdf(
    invoice,
    rate,
    await dealerTimezone(invoice.dealerId),
    await getDealerPdfBranding(invoice.dealerId),
  );
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="SV-${String(invoice.id).padStart(5, "0")}.pdf"`,
    )
    .send(pdf);
});

// ---------------------------------------------------------------------------
// Warranty / AMC coverage
// ---------------------------------------------------------------------------

router.get("/coverage", async (req, res): Promise<void> => {
  const query = ListCoveragePlansQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(coveragePlansTable)
    .where(
      and(
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
        query.data.type
          ? eq(coveragePlansTable.type, query.data.type)
          : undefined,
      ),
    )
    .orderBy(coveragePlansTable.endDate);
  res.json(ListCoveragePlansResponse.parse(rows));
});

router.post("/coverage", async (req, res): Promise<void> => {
  const parsed = CreateCoveragePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [plan] = await db
    .insert(coveragePlansTable)
    .values({
      ...parsed.data,
      dealerId: activeDealerId(res),
      startDate: toDateString(parsed.data.startDate)!,
      endDate: toDateString(parsed.data.endDate)!,
    })
    .returning();
  res.status(201).json(CreateCoveragePlanResponse.parse(plan));
});

router.get("/coverage/:id/pdf", async (req, res): Promise<void> => {
  const params = UpdateCoveragePlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [plan] = await db
    .select()
    .from(coveragePlansTable)
    .where(
      and(
        eq(coveragePlansTable.id, params.data.id),
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!plan) {
    res.status(404).json({ error: "Coverage plan not found" });
    return;
  }
  const pdf = await buildCoverageCertificatePdf(
    plan,
    await dealerTimezone(plan.dealerId),
    await getDealerPdfBranding(plan.dealerId),
  );
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="CP-${String(plan.id).padStart(5, "0")}-certificate.pdf"`,
    )
    .send(pdf);
});

router.patch("/coverage/:id", async (req, res): Promise<void> => {
  const params = UpdateCoveragePlanParams.safeParse(req.params);
  const parsed = UpdateCoveragePlanBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const { startDate, endDate, ...rest } = parsed.data;
  const patch: Record<string, unknown> = { ...rest };
  const start = toDateString(startDate);
  const end = toDateString(endDate);
  if (start) patch.startDate = start;
  if (end) patch.endDate = end;

  const [plan] = await db
    .update(coveragePlansTable)
    .set(patch)
    .where(
      and(
        eq(coveragePlansTable.id, params.data.id),
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!plan) {
    res.status(404).json({ error: "Coverage plan not found" });
    return;
  }
  res.json(UpdateCoveragePlanResponse.parse(plan));
});

router.post("/coverage/:id/remind", async (req, res): Promise<void> => {
  const params = SendCoverageReminderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [plan] = await db
    .select()
    .from(coveragePlansTable)
    .where(
      and(
        eq(coveragePlansTable.id, params.data.id),
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!plan) {
    res.status(404).json({ error: "Coverage plan not found" });
    return;
  }
  const { email } = await customerEmail(plan.customerId, plan.dealerId);
  if (!email) {
    res.status(422).json({ error: "Customer has no email on file" });
    return;
  }
  await enqueueEmail({
    template: "warranty_reminder",
    to: email,
    dealerId: plan.dealerId,
    customerId: plan.customerId,
    data: { vehicle: plan.vehicleInfo, expiry: plan.endDate },
  });
  res.json(
    SendCoverageReminderResponse.parse({ status: "queued", recipient: email }),
  );
});

export default router;
