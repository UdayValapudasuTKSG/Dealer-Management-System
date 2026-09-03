import { and, desc, eq, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import {
  db,
  customersTable,
  dealersTable,
  emailLogsTable,
  emailTemplateOverridesTable,
  leadsTable,
  quotesTable,
  notificationsTable,
  receiptsTable,
  serviceInvoicesTable,
  serviceOrdersTable,
  jobCardsTable,
  tasksTable,
  timelineEventsTable,
  whatsappConversationsTable,
  whatsappMessagesTable,
  EMAIL_TEMPLATES,
  type EmailTemplate,
  type EmailLog,
  type EmailTemplateOverride,
  type WhatsappKind,
  type NotificationType,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  resolveDealerSmtp,
  smtpSkipMessage,
  sanitizeSmtpError,
} from "./smtp-connection";
import { buildQuotePdf } from "./quote-pdf";
import {
  buildInvoicePdfFromPayload,
  buildReceiptPdf,
  buildServiceInvoicePdf,
} from "./document-pdfs";
import { getDealerPdfBranding } from "./dealer-branding";
import { buildWarrantyBookletForDelivery } from "./warranty-doc";
import { serviceIcsFromPayload, testDriveIcsFromPayload } from "./calendar";
import { dealerTimezone, zonedAddDays, zonedDayKey } from "./timezone";
import {
  sendWhatsappButtons,
  sendWhatsappDocument,
  sendWhatsappList,
  sendWhatsappText,
  sendWhatsappTemplate,
  uploadWhatsappDocument,
  whatsappSendFailureDisposition,
  WhatsappProviderSendError,
  type WhatsappButton,
  type WhatsappListRow,
} from "./whatsapp";
import { getChannelByDealerId } from "./whatsapp-channel";
import {
  recordWhatsappMessage,
  updateWhatsappDeliveryStatus,
} from "./whatsapp-log";
import { normalizeWhatsappPhone } from "./whatsapp-phone";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Header stamped on every email the server sends. The Gmail intake agent
 * skips messages carrying it, so system mail (quotes, reminders, lifecycle
 * emails) sent from the monitored inbox to itself never loops back into leads
 * — while genuine self-sent human mail is still processed.
 */
export const SYSTEM_MAIL_HEADER = "X-AURA-System";

// Email is sent exclusively through each dealer's own SMTP connection
// (see ./smtp-connection). There is NO global/shared sender fallback.

// ---------------------------------------------------------------------------
// Templates — premium automotive-branded HTML
// ---------------------------------------------------------------------------

export type TemplateData = Record<string, string>;

type TemplateDef = {
  label: string;
  description: string;
  subject: (d: TemplateData) => string;
  heading: (d: TemplateData) => string;
  body: (d: TemplateData) => string;
  cta?: (d: TemplateData) => { label: string; note?: string; href?: string };
  sample: TemplateData;
};

const d = (data: TemplateData, key: string, fallback: string) =>
  data[key] && data[key].trim() ? data[key] : fallback;

export const TEMPLATE_DEFS: Record<EmailTemplate, TemplateDef> = {
  "parts.requisition.submitted": {
    label: "New parts requisition",
    description: "Alerts Parts Advisors when a new workshop requisition arrives.",
    subject: (x) => `New parts requisition — ${d(x, "reference", "Workshop request")}`,
    heading: () => "A new parts request needs attention",
    body: (x) => d(x, "body", "A new parts requisition has been submitted."),
    cta: (x) => x.link
      ? { label: "Review requisition", href: x.link }
      : { label: "Review requisition" },
    sample: {
      reference: "Requisition #1042",
      body: "A technician submitted 3 requested items for Job Card #231.",
      link: "/parts",
    },
  },
  "parts.inventory.reorder": {
    label: "Parts inventory reorder alert",
    description: "Alerts Parts Advisors when inventory reaches its reorder threshold.",
    subject: (x) => `Reorder required — ${d(x, "partName", "Inventory part")}`,
    heading: () => "Inventory has reached its reorder threshold",
    body: (x) => d(x, "body", "A part now needs replenishment."),
    cta: (x) => x.link
      ? { label: "Open parts inventory", href: x.link }
      : { label: "Open parts inventory" },
    sample: {
      partName: "Oil filter",
      body: "OF-100: 5 on hand, at the reorder level of 5.",
      link: "/parts",
    },
  },
  "collision.claim.communication": {
    label: "Collision claim communication",
    description: "Staff-reviewed collision claim email.",
    subject: (x) => d(x, "subject", "Collision claim update"),
    heading: (x) => d(x, "subject", "Collision claim update"),
    body: (x) => d(x, "body", ""),
    sample: { subject: "Collision claim update", body: "Your claim has been updated." },
  },
  lead_received: {
    label: "Lead Received",
    description: "Warm welcome the moment an enquiry lands.",
    subject: (x) => `We received your enquiry, ${d(x, "name", "there")}`,
    heading: (x) => `Welcome to ${d(x, "__brand", "AURA")}, ${d(x, "name", "there")}`,
    body: (x) =>
      `Thank you for your interest in the <strong>${d(x, "vehicle", "vehicle of your choice")}</strong>. Your personal sales advisor has been assigned and will reach out shortly with availability, pricing and a tailored walk-through.`,
    cta: () => ({ label: "Your sales advisor is on it" }),
    sample: { name: "Alex Mensah", vehicle: "2026 Aston Martin DB12" },
  },
  vehicle_quote: {
    label: "Vehicle Quote",
    description: "Sends a branded PDF quotation for the vehicle of interest.",
    subject: (x) => `Your personalised quote — ${d(x, "vehicle", "your vehicle")}`,
    heading: (x) => `Your quote is ready, ${d(x, "name", "there")}`,
    body: (x) =>
      `Thank you for your interest in the <strong>${d(x, "vehicle", "vehicle of your choice")}</strong>. Your personalised quotation is attached as a PDF — it covers the ${d(x, "color", "selected")} finish at <strong>${d(x, "totalGyd", d(x, "total", "the current showroom price"))}</strong> and is valid until <strong>${d(x, "validUntil", "the date shown on the quote")}</strong>. Your sales advisor will follow up shortly to arrange a viewing or test drive.`,
    cta: (x) =>
      x.link
        ? { label: "Book your test drive", href: x.link }
        : { label: "Your quotation is attached" },
    sample: {
      name: "Alex Mensah",
      vehicle: "BMW i7 xDrive60",
      color: "Obsidian Black",
      total: "$125,000",
      validUntil: "July 29, 2026",
    },
  },
  test_drive_invite: {
    label: "Test Drive Invite",
    description:
      "Invites the customer to arrange a test drive by calling their sales advisor.",
    subject: (x) =>
      `Reserve your test drive${x.vehicle ? ` — ${x.vehicle}` : ""}`,
    heading: (x) => `Take the wheel, ${d(x, "name", "there")}`,
    body: (x) =>
      `The <strong>${d(x, "vehicle", "vehicle of your choice")}</strong> is ready when you are. ` +
      (x.link
        ? `Pick a 30-minute slot that suits you using the booking link below — it reserves the vehicle and your sales advisor${x.advisorName ? ` <strong>${x.advisorName}</strong>` : ""} exclusively for your drive.` +
          (x.advisorPhone
            ? ` Questions? Call <strong>${d(x, "advisorName", "your sales advisor")}</strong> on <strong>${x.advisorPhone}</strong>.`
            : "")
        : x.advisorPhone
          ? `To arrange a time that suits you, call your sales advisor <strong>${d(x, "advisorName", "our team")}</strong> on <strong>${x.advisorPhone}</strong> — the vehicle will be detailed, charged/fuelled and waiting at the showroom entrance.`
          : `Your sales advisor${x.advisorName ? ` <strong>${x.advisorName}</strong>` : ""} will call you shortly to arrange a time — the vehicle will be detailed, charged/fuelled and waiting at the showroom entrance.`),
    cta: (x) =>
      x.link
        ? { label: "Book your test drive", href: x.link }
        : x.advisorPhone
          ? {
              label: `Call ${d(x, "advisorName", "your sales advisor")} — ${x.advisorPhone}`,
              href: `tel:${x.advisorPhone.replace(/[^+\d]/g, "")}`,
            }
          : { label: "Your sales advisor will call you" },
    sample: {
      name: "Alex Mensah",
      vehicle: "BMW i7 xDrive60",
      advisorName: "Alex Fernandes",
      advisorPhone: "+592 600 1234",
    },
  },
  test_drive_confirmation: {
    label: "Test Drive Confirmation",
    description: "Confirms a scheduled test drive appointment.",
    subject: (x) =>
      x.rescheduled === "true"
        ? `Your test drive has been rescheduled — ${d(x, "vehicle", "your vehicle")}`
        : `Your test drive is confirmed — ${d(x, "vehicle", "your vehicle")}`,
    heading: (x) =>
      x.rescheduled === "true"
        ? "Your test drive has been rescheduled"
        : "Your test drive is confirmed",
    body: (x) =>
      `${x.rescheduled === "true" && x.previousLabel ? `As discussed, your test drive has been moved from ${x.previousLabel}. ` : ""}We look forward to hosting you on <strong>${d(x, "date", "your scheduled date")}</strong> at ${d(x, "time", "the agreed time")}. The <strong>${d(x, "vehicle", "vehicle")}</strong> will be detailed, charged/fuelled and waiting at the showroom entrance.${x.mapsLink ? ` <a href="${x.mapsLink}">Get directions to the showroom</a>.` : ""}`,
    cta: (x) =>
      x.mapsLink
        ? { label: "Directions to the showroom", href: x.mapsLink }
        : { label: "Showroom sales advisor will greet you" },
    sample: { vehicle: "2026 BMW i7", date: "Friday, July 18", time: "10:30 AM" },
  },
  test_drive_owner_invite: {
    label: "Test Drive — Owner Calendar Invite",
    description:
      "Puts a booked test drive on the lead owner's calendar with an .ics invite.",
    subject: (x) =>
      `Test drive booked — ${d(x, "leadName", "your lead")}, ${d(x, "date", "upcoming")}`,
    heading: (x) => `Test drive: ${d(x, "leadName", "your lead")}`,
    body: (x) =>
      `<strong>${d(x, "leadName", "Your lead")}</strong> has a test drive booked for <strong>${d(x, "date", "the scheduled date")}</strong> at ${d(x, "time", "the agreed time")} — ${d(x, "vehicle", "the vehicle of interest")}${x.branch ? `, ${x.branch} branch` : ""}. The attached invite adds it straight to your calendar. Have the car detailed, charged/fuelled and ready fifteen minutes ahead.`,
    cta: () => ({ label: "Calendar invite attached" }),
    sample: {
      leadName: "Alex Mensah",
      vehicle: "BMW i7 xDrive60",
      date: "Friday, July 18",
      time: "10:30 AM",
      branch: "Main Showroom",
    },
  },
  lead_assignment: {
    label: "Lead Assignment",
    description: "Introduces the assigned advisor to the customer.",
    subject: (x) => `${d(x, "advisor", "Your advisor")} is your personal ${d(x, "__brand", "AURA")} advisor`,
    heading: (x) => `Meet ${d(x, "advisor", "your advisor")}`,
    body: (x) =>
      `<strong>${d(x, "advisor", "Your advisor")}</strong> now leads your journey with us and is across every detail of your enquiry${x.vehicle ? ` for the <strong>${x.vehicle}</strong>` : ""}. Expect a personal introduction shortly.`,
    sample: { advisor: "Nana Adjei", vehicle: "Mercedes-AMG GT 63" },
  },
  finance_processing: {
    label: "Finance Processing",
    description: "Confirms a finance application is under review.",
    subject: () => "Your finance application is being processed",
    heading: () => "Financing in motion",
    body: (x) =>
      `Your application for <strong>${d(x, "amount", "the requested amount")}</strong> is now with our finance desk. We typically return a decision within one business day — no action is needed from you.`,
    sample: { amount: "$86,500" },
  },
  finance_approved: {
    label: "Finance Approved",
    description: "Celebrates an approved finance application.",
    subject: () => "Approved — your financing is ready",
    heading: () => "Congratulations, you're approved",
    body: (x) =>
      `Your financing of <strong>${d(x, "amount", "the requested amount")}</strong>${x.lender ? ` with <strong>${x.lender}</strong>` : ""} has been approved${x.apr ? ` at ${x.apr} APR` : ""}. Your advisor will walk you through the final paperwork.`,
    cta: () => ({ label: "One step closer to delivery" }),
    sample: { amount: "$86,500", lender: "Stanbic Auto Finance", apr: "7.9%" },
  },
  vehicle_booking: {
    label: "Vehicle Booking",
    description: "Confirms a vehicle reservation / booking.",
    subject: (x) => `Reserved: ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Your vehicle is reserved",
    body: (x) =>
      `The <strong>${d(x, "vehicle", "vehicle")}</strong> is now held exclusively for you${x.deposit ? ` against a deposit of <strong>${x.deposit}</strong>` : ""}. It has been moved off the showroom floor while we prepare your paperwork.`,
    sample: { vehicle: "2026 Porsche Taycan Turbo", deposit: "$5,000" },
  },
  payment_reminder: {
    label: "Payment Reminder",
    description: "Gentle reminder of an upcoming payment.",
    subject: (x) => `A gentle reminder from ${d(x, "__brand", "AURA")}`,
    heading: () => "Upcoming payment",
    body: (x) =>
      `This is a courtesy reminder that a payment of <strong>${d(x, "amount", "your scheduled amount")}</strong> is due on <strong>${d(x, "dueDate", "the scheduled date")}</strong>. If it's already on its way, please disregard this note.`,
    sample: { amount: "$2,150", dueDate: "July 25, 2026" },
  },
  payment_received: {
    label: "Payment Received",
    description: "Thanks the customer and confirms a recorded payment, with the receipt attached.",
    subject: (x) => `Payment received — ${d(x, "amount", "thank you")}`,
    heading: (x) => `Thank you, ${d(x, "name", "we've received your payment")}`,
    body: (x) =>
      `We've received your payment of <strong>${d(x, "amount", "the recorded amount")}</strong>${x.method ? ` via <strong>${x.method}</strong>` : ""} against invoice <strong>${d(x, "invoiceNumber", "your invoice")}</strong>. ${
        x.balance && x.balance !== "GY$0"
          ? `Your remaining balance is <strong>${x.balance}</strong>.`
          : "This invoice is now fully settled — nothing further is due."
      } Your official receipt is attached as a PDF.`,
    cta: () => ({ label: "Receipt attached" }),
    sample: {
      name: "Alex Mensah",
      amount: "GY$1,500,000",
      method: "bank transfer",
      invoiceNumber: "INV-2026-0141",
      balance: "GY$56,517,800",
    },
  },
  refund_confirmation: {
    label: "Refund Confirmation",
    description: "Confirms a cancellation refund has been issued.",
    subject: (x) => `Your refund of ${d(x, "amount", "your deposit")} is on its way`,
    heading: () => "Refund confirmed",
    body: (x) =>
      `Your reservation for the <strong>${d(x, "vehicle", "vehicle")}</strong> has been cancelled and a refund of <strong>${d(x, "amount", "your deposit")}</strong> has been issued via ${d(x, "method", "your original payment method")} (reference ${d(x, "reference", "on file")}). Please allow 3–5 business days for the funds to reflect. We'd love to welcome you back whenever the time is right.`,
    sample: {
      vehicle: "2026 Porsche Taycan Turbo",
      amount: "$5,000",
      method: "bank transfer",
      reference: "RF-2026-0001",
    },
  },
  vehicle_ready: {
    label: "Vehicle Ready",
    description: "Tells the customer their vehicle is ready for pickup after service.",
    subject: (x) => `Your ${d(x, "vehicle", "vehicle")} is ready`,
    heading: () => "Your vehicle is ready",
    body: (x) =>
      `Great news — the <strong>${d(x, "service", "requested work")}</strong> on your <strong>${d(x, "vehicle", "vehicle")}</strong> is complete. It has been quality-checked and is waiting at service reception.${x.balance ? ` Balance due: <strong>${x.balance}</strong>.` : ""} Please reply for current collection hours, payment options, or collection assistance.`,
    cta: () => ({ label: "Ready when you are" }),
    sample: { vehicle: "2025 BMW X7", service: "20,000 km service", balance: "GY$45,200" },
  },
  delivery_schedule: {
    label: "Delivery Schedule",
    description: "Shares the planned delivery date and details.",
    subject: (x) => `Delivery scheduled — ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Your delivery is scheduled",
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "vehicle")}</strong> is set for handover on <strong>${d(x, "date", "the scheduled date")}</strong>. Detailing, registration and the full charge/fuel are all being handled ahead of the moment.`,
    cta: () => ({ label: "The countdown begins" }),
    sample: { vehicle: "2026 Range Rover Autobiography", date: "Saturday, July 26" },
  },
  delivery_advisor_assigned: {
    label: "Delivery Advisor Assigned",
    description: "Introduces the customer's dedicated delivery advisor.",
    subject: (x) => `Your delivery advisor — ${d(x, "advisor", "your dedicated advisor")}`,
    heading: (x) => `Meet ${d(x, "advisor", "your delivery advisor")}`,
    body: (x) =>
      `Great news${x.name ? `, <strong>${x.name}</strong>` : ""} — <strong>${d(x, "advisor", "your delivery advisor")}</strong> will personally guide the handover of your <strong>${d(x, "vehicle", "new vehicle")}</strong>. They will coordinate preparation, registration and your delivery appointment, and will be in touch shortly to arrange the details.`,
    cta: () => ({ label: "We'll be in touch soon" }),
    sample: { name: "Alex", advisor: "Jordan Persaud", vehicle: "2026 Foton Tunland G7" },
  },
  delivery_confirmation: {
    label: "Delivery Confirmation",
    description: "Celebrates the completed handover.",
    subject: () => "Welcome to the family — delivery complete",
    heading: (x) => `The keys are yours, ${d(x, "name", "and it suits you")}`,
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "new vehicle")}</strong> has been delivered. Every ${d(x, "__brand", "AURA")} vehicle includes our sales advisor aftercare — service bookings, warranty and support are one message away.`,
    sample: { name: "Alex", vehicle: "2026 Bentley Continental GT" },
  },
  service_reminder: {
    label: "Service Reminder",
    description: "Reminds the customer of upcoming service.",
    subject: (x) => `Service due — ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Time for a little care",
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "vehicle")}</strong> is due for <strong>${d(x, "service", "scheduled maintenance")}</strong>${x.date ? ` around <strong>${x.date}</strong>` : ""}. Reply to this email or call your sales advisor and we'll arrange pickup.`,
    sample: { vehicle: "2025 BMW X7", service: "20,000 km service", date: "August 2" },
  },
  warranty_reminder: {
    label: "Warranty Reminder",
    description: "Flags an approaching warranty expiry.",
    subject: () => "Your warranty window is closing",
    heading: () => "Warranty check-in",
    body: (x) =>
      `The factory warranty on your <strong>${d(x, "vehicle", "vehicle")}</strong> expires on <strong>${d(x, "expiry", "the recorded date")}</strong>. Book a complimentary pre-expiry inspection so anything covered is handled in time.`,
    sample: { vehicle: "2024 Audi e-tron GT", expiry: "September 15, 2026" },
  },
  feedback_request: {
    label: "Feedback Request",
    description: "Invites the customer to rate their experience.",
    subject: () => "How did we do?",
    heading: (x) => `Your opinion shapes ${d(x, "__brand", "AURA")}`,
    body: (x) =>
      `Thank you for choosing us${x.context ? ` for ${x.context}` : ""}. If you have two minutes, we'd love to hear how the experience felt — every note reaches the general manager directly.`,
    sample: { context: "your recent delivery" },
  },
  thank_you: {
    label: "Thank You",
    description: "A simple, elegant thank-you note.",
    subject: (x) => `Thank you, ${d(x, "name", `from all of us at ${d(x, "__brand", "AURA")}`)}`,
    heading: () => "Thank you",
    body: (x) =>
      `${d(x, "message", `It has been a privilege to look after you. From everyone at ${d(x, "__brand", "AURA")}, thank you for your trust — we're here whenever you need us.`)}`,
    sample: { name: "Alex", message: "It has been a privilege to look after you this month. From everyone at AURA — thank you." },
  },
  outreach: {
    label: "Personal Outreach",
    description: "A personal note from the advisor, drafted with AI and approved before sending.",
    subject: (x) => d(x, "subject", `A note from ${d(x, "advisor", `your ${d(x, "__brand", "AURA")} advisor`)}`),
    heading: (x) => `Hello ${d(x, "name", "there")}`,
    body: (x) =>
      `${d(x, "message", "Your advisor has an update for you.").replace(/\n/g, "<br/>")}`,
    cta: (x) => ({ label: d(x, "advisor", `Your ${d(x, "__brand", "AURA")} advisor`) }),
    sample: {
      name: "Alex Mensah",
      advisor: "Nana Adjei",
      message: "Great news — the i7 you asked about arrives this Friday. Shall I hold a viewing slot for you?",
    },
  },
  owner_invite: {
    label: "Owner-Admin Invite",
    description: "Invites the first General Manager of a newly provisioned dealership.",
    subject: (x) => `You've been invited to run ${d(x, "dealerName", "your dealership")} on AURA`,
    heading: (x) => `Welcome aboard, ${d(x, "name", "General Manager")}`,
    body: (x) =>
      `You have been invited as the founding <strong>General Manager</strong> of <strong>${d(x, "dealerName", "your dealership")}</strong> on the AURA Dealership Operating System. Simply sign in with this email address — your workspace, role and permissions are provisioned and will attach automatically the first time you log in.`,
    cta: () => ({ label: "Sign in to claim your workspace" }),
    sample: { name: "Priya Persaud", dealerName: "CAM Motors Georgetown" },
  },
  smtp_test: {
    label: "SMTP Test",
    description: "Verifies the Gmail SMTP configuration.",
    subject: () => "AURA email engine — test successful",
    heading: () => "Your email engine is live",
    body: () =>
      `This is a test message from the AURA Dealership OS email engine. If you're reading this, your Gmail SMTP configuration is working perfectly.`,
    sample: {},
  },

  // -------------------------------------------------------------------------
  // R6.2 notification-matrix templates (dotted ids). Internal-facing ones are
  // addressed to staff; customer-facing ones follow the sales advisor voice.
  // -------------------------------------------------------------------------
  "lead.new": {
    label: "New Lead (Internal)",
    description: "Alerts sales managers that a new lead arrived.",
    subject: (x) => `New lead: ${d(x, "name", "Unnamed")} — ${d(x, "vehicle", "no vehicle yet")}`,
    heading: (x) => `New ${d(x, "source", "inbound")} lead`,
    body: (x) =>
      `<strong>${d(x, "name", "A new customer")}</strong> just came in via <strong>${d(x, "source", "an inbound channel")}</strong>${x.vehicle ? ` asking about <strong>${x.vehicle}</strong>` : ""}. Review and assign an advisor before the response clock runs down.`,
    sample: { name: "Alex Mensah", source: "Website", vehicle: "2026 Toyota Land Cruiser" },
  },
  "lead.assigned": {
    label: "Lead Assigned (Internal)",
    description: "Tells an advisor a lead is now theirs.",
    subject: (x) => `Lead assigned to you: ${d(x, "name", "new customer")}`,
    heading: () => "A lead is now yours",
    body: (x) =>
      `<strong>${d(x, "name", "A customer")}</strong>${x.vehicle ? ` (interested in <strong>${x.vehicle}</strong>)` : ""} has been assigned to you. First contact within the SLA window keeps the pipeline green.`,
    sample: { name: "Alex Mensah", vehicle: "2026 Toyota Land Cruiser" },
  },
  "lead.sla.breach.advisor": {
    label: "SLA Breach — Advisor (Internal)",
    description: "First-contact SLA breached; advisor must act.",
    subject: (x) => `SLA breached: ${d(x, "name", "lead")} still uncontacted`,
    heading: () => "First-contact SLA breached",
    body: (x) =>
      `<strong>${d(x, "name", "A lead")}</strong> has passed the <strong>${d(x, "sla", "24-hour")}</strong> first-contact window without an outreach on record. Contact them now and log the touch.`,
    sample: { name: "Alex Mensah", sla: "24-hour" },
  },
  "lead.sla.breach.manager": {
    label: "SLA Breach — Manager (Internal)",
    description: "Escalates a breached lead to the manager.",
    subject: (x) => `Escalation: ${d(x, "name", "lead")} breached first-contact SLA`,
    heading: () => "Lead escalation",
    body: (x) =>
      `<strong>${d(x, "name", "A lead")}</strong> assigned to <strong>${d(x, "advisor", "an advisor")}</strong> has breached the first-contact SLA. Consider reassigning or stepping in.`,
    sample: { name: "Alex Mensah", advisor: "Nana Adjei" },
  },
  "testdrive.reminder.24h": {
    label: "Test Drive Reminder (24h)",
    description: "Reminds the customer of tomorrow's test drive.",
    subject: (x) => `Tomorrow: your test drive — ${d(x, "vehicle", "your vehicle")}`,
    heading: (x) => `See you tomorrow, ${d(x, "name", "we're ready")}`,
    body: (x) =>
      `Your test drive of the <strong>${d(x, "vehicle", "vehicle")}</strong> is booked for <strong>${d(x, "when", "tomorrow")}</strong>. The car will be fuelled, detailed and waiting. Reply if you need to reschedule.`,
    sample: { name: "Alex", vehicle: "2026 Bentley Continental GT", when: "tomorrow at 10:00" },
  },
  "reservation.pending": {
    label: "Reservation Pending",
    description: "Nudges the customer to complete a pending reservation.",
    subject: (x) => `Your reservation on ${d(x, "vehicle", "the vehicle")} is waiting`,
    heading: () => "Your reservation is almost complete",
    body: (x) =>
      `The <strong>${d(x, "vehicle", "vehicle")}</strong> is being held for you${x.until ? ` until <strong>${x.until}</strong>` : ""}. Complete the reservation to lock it in — after that the hold is released.`,
    sample: { vehicle: "2025 BMW X7", until: "Friday 5 PM" },
  },
  "invoice.generated": {
    label: "Invoice Generated",
    description: "Sends the customer their invoice (PDF attached).",
    subject: (x) => `Your ${d(x, "__brand", "AURA")} invoice ${d(x, "invoiceNumber", "")}`.trim(),
    heading: () => "Your invoice is ready",
    body: (x) =>
      `Invoice <strong>${d(x, "invoiceNumber", "")}</strong> for the <strong>${d(x, "vehicle", "vehicle")}</strong> has been issued — total <strong>${d(x, "total", "")}</strong>${x.dueDate ? `, due <strong>${x.dueDate}</strong>` : ""}. The PDF is attached; your advisor is on hand for any question.`,
    sample: { invoiceNumber: "INV-2043", vehicle: "2026 Toyota Land Cruiser", total: "$86,400", dueDate: "August 12" },
  },
  "document.missing.internal": {
    label: "Missing Document (Internal)",
    description: "Flags a missing/expiring compliance document to staff.",
    subject: (x) => `Document needed: ${d(x, "doc", "compliance document")} — ${d(x, "name", "record")}`,
    heading: () => "Document gap detected",
    body: (x) =>
      `<strong>${d(x, "doc", "A required document")}</strong> is missing or expiring on <strong>${d(x, "name", "this record")}</strong>. Chase it down before it blocks the next gate.`,
    sample: { doc: "Proof of insurance", name: "Deal #88 — Alex Mensah" },
  },
  "document.request.customer": {
    label: "Document Request (Customer)",
    description: "Asks the customer for an outstanding document.",
    subject: (x) => `One document needed: ${d(x, "doc", "a document")}`,
    heading: (x) => `Almost there, ${d(x, "name", "one item left")}`,
    body: (x) =>
      `To keep everything moving we just need your <strong>${d(x, "doc", "document")}</strong>. Reply to this email with a photo or scan, or hand it to your advisor at the showroom.`,
    sample: { name: "Alex", doc: "valid driver's licence" },
  },
  "cancellation.manager": {
    label: "Cancellation (Internal)",
    description: "Notifies the manager of a cancellation.",
    subject: (x) => `Cancelled: ${d(x, "what", "a record")}`,
    heading: () => "Cancellation logged",
    body: (x) =>
      `<strong>${d(x, "what", "A record")}</strong> was cancelled${x.reason ? ` — reason: <strong>${x.reason}</strong>` : ""}. Review for follow-up or recovery outreach.`,
    sample: { what: "Deal #88 — Alex Mensah", reason: "financing declined" },
  },
  "refund.approved.finance": {
    label: "Refund Approved (Internal)",
    description: "Tells finance a refund gate was approved and needs paying.",
    subject: (x) => `Refund approved — process payout for ${d(x, "name", "customer")}`,
    heading: () => "Refund cleared for payout",
    body: (x) =>
      `A refund of <strong>${d(x, "amount", "")}</strong> for <strong>${d(x, "name", "the customer")}</strong> has been approved. Process the payout and record the payment against the invoice.`,
    sample: { amount: "$5,000", name: "Alex Mensah" },
  },
  "refund.customer": {
    label: "Refund Processed (Customer)",
    description: "Confirms the customer's refund has been paid.",
    subject: () => "Your refund has been processed",
    heading: (x) => `Your refund is on its way, ${d(x, "name", "")}`.trim(),
    body: (x) =>
      `Your refund of <strong>${d(x, "amount", "")}</strong> has been processed${x.method ? ` via <strong>${x.method}</strong>` : ""}. Depending on your bank it may take a few business days to appear.`,
    sample: { name: "Alex", amount: "$5,000", method: "bank transfer" },
  },
  "delivery.ready": {
    label: "Delivery Ready",
    description: "Invites the customer to collect their vehicle.",
    subject: (x) => `Your ${d(x, "vehicle", "vehicle")} is ready for delivery`,
    heading: (x) => `It's ready, ${d(x, "name", "and it's beautiful")}`,
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "vehicle")}</strong> has cleared preparation and is ready for handover${x.when ? ` — scheduled for <strong>${x.when}</strong>` : ""}. Your advisor will walk you through every detail at collection.`,
    sample: { name: "Alex", vehicle: "2026 Bentley Continental GT", when: "Saturday 11:00" },
  },
  "delivered.service.handoff": {
    label: "Service Handoff (Internal)",
    description: "Tells the service team a vehicle was delivered — aftercare begins.",
    subject: (x) => `Aftercare handoff: ${d(x, "vehicle", "vehicle")} delivered`,
    heading: () => "New vehicle in aftercare",
    body: (x) =>
      `<strong>${d(x, "vehicle", "A vehicle")}</strong> was delivered to <strong>${d(x, "name", "the customer")}</strong>. The service cadence starts now — first check-in lands on the schedule automatically.`,
    sample: { vehicle: "2026 Toyota Land Cruiser", name: "Alex Mensah" },
  },
  "warranty.document": {
    label: "Warranty Document",
    description: "Sends the customer their autofilled warranty booklet.",
    subject: (x) => `Your warranty documents — ${d(x, "vehicle", "your vehicle")}`,
    heading: (x) => `Your warranty, ${d(x, "name", "all set")}`,
    body: (x) =>
      `Attached is the warranty booklet for your <strong>${d(x, "vehicle", "vehicle")}</strong>, pre-filled with your details and the delivery date. Keep it with your vehicle papers — and if anything ever needs attention, your service team is one message away.`,
    cta: () => ({ label: "Covered from day one" }),
    sample: { name: "Alex", vehicle: "2026 BYD Sealion 6" },
  },
  "case.opened": {
    label: "Service Case Opened (Internal)",
    description: "Alerts the assigned service advisor to a new case.",
    subject: (x) => `New service case: ${d(x, "title", "case")}`,
    heading: () => "A service case needs you",
    body: (x) =>
      `Case <strong>${d(x, "title", "")}</strong> for <strong>${d(x, "name", "a customer")}</strong> has been opened and assigned to you. Triage it and set expectations with the customer.`,
    sample: { title: "Brake noise — front left", name: "Alex Mensah" },
  },
  "manager.note.advisor": {
    label: "Manager Note (Internal)",
    description: "Flags a manager note on a record to the owning advisor.",
    subject: (x) => `Manager note on ${d(x, "what", "your record")}`,
    heading: () => "A note from your manager",
    body: (x) =>
      `<strong>${d(x, "manager", "Your manager")}</strong> left a note on <strong>${d(x, "what", "one of your records")}</strong>: <em>${d(x, "note", "")}</em>`,
    sample: { manager: "Priya Persaud", what: "Lead — Alex Mensah", note: "Offer the extended warranty at delivery." },
  },
  "feedback.survey": {
    label: "Feedback Survey",
    description: "Post-milestone CSAT survey invitation.",
    subject: (x) => `Two minutes to shape your ${d(x, "__brand", "AURA")} experience`,
    heading: (x) => `How did we do, ${d(x, "name", "")}?`.trim(),
    body: (x) =>
      `Thank you${x.context ? ` for ${x.context}` : ""}. We'd love two minutes of your time — your feedback goes straight to the general manager and shapes how we look after you next.`,
    cta: (x) =>
      x.link
        ? { label: "Share your feedback", href: x.link }
        : { label: "We appreciate you" },
    sample: { name: "Alex", context: "your recent delivery" },
  },
  "service.cadence.due": {
    label: "Service Cadence Due",
    description: "Scheduled aftercare check-in for a delivered vehicle.",
    subject: (x) => `Time for your ${d(x, "vehicle", "vehicle")} check-in`,
    heading: () => "A little care goes a long way",
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "vehicle")}</strong> is due its <strong>${d(x, "milestone", "scheduled")}</strong> check-in. Reply to this email or message your sales advisor and we'll arrange everything, including pickup.`,
    sample: { vehicle: "2026 Toyota Land Cruiser", milestone: "6-month" },
  },

  // -------------------------------------------------------------------------
  // FR-COM-01..03 service milestone + management summary templates
  // -------------------------------------------------------------------------
  "service.booking.confirmed": {
    label: "Service Booking Confirmed",
    description: "Confirms a service booking the moment it is scheduled.",
    subject: (x) => `Your service is booked — ${d(x, "date", "confirmed")}`,
    heading: (x) => `You're booked in, ${d(x, "name", "see you soon")}`,
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "vehicle")}</strong> is booked for <strong>${d(x, "service", "service")}</strong> on <strong>${d(x, "date", "the scheduled date")}</strong>. Arrive at your convenience that morning — our service reception will have everything ready. Reply to this email if you need to adjust the date.`,
    cta: () => ({ label: "We'll take it from here" }),
    sample: {
      name: "Alex Mensah",
      vehicle: "2025 BMW X7",
      service: "maintenance",
      date: "August 14, 2026",
    },
  },
  "service.booking.received": {
    label: "Service Booking Request Received",
    description: "Acknowledges the customer's requested service date before confirmation.",
    subject: (x) => `We received your service request — ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Your service request is with us",
    body: (x) =>
      `We received your request for <strong>${d(x, "service", "service")}</strong> for your <strong>${d(x, "vehicle", "vehicle")}</strong>, with a preferred date of <strong>${d(x, "date", "the date requested")}</strong>${x.dealer ? ` at <strong>${x.dealer}</strong>` : ""}. This is a request receipt, not yet an appointment confirmation. Your service team will confirm the time shortly.`,
    sample: { name: "Alex", vehicle: "2025 BMW X7", service: "maintenance", date: "August 14, 2026", dealer: "Main Service Centre" },
  },
  "customer.vehicle.onboarding": {
    label: "Customer Vehicle Onboarding",
    description: "Secure email-only invitation to add a vehicle to the customer's garage.",
    subject: () => "Add your vehicle details securely",
    heading: (x) => `Add your vehicle, ${d(x, "name", "valued customer")}`,
    body: () =>
      "Use the secure form to add your vehicle details and your own photos or videos. This private link expires and may be used only once.",
    cta: (x) => ({ label: "Add my vehicle", href: d(x, "link", "#") }),
    sample: { name: "Alex", link: "https://example.com/vehicle-onboarding/secure-token" },
  },
  "service.appointment.confirmed": {
    label: "Service Appointment Confirmed",
    description: "Confirms the appointment and attaches an RFC 5545 calendar invitation.",
    subject: (x) => `Confirmed: service appointment — ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Your service appointment is confirmed",
    body: (x) =>
      `We have confirmed <strong>${d(x, "date", "your appointment")}</strong> at <strong>${d(x, "time", "the agreed time")}</strong> for your <strong>${d(x, "vehicle", "vehicle")}</strong>. ${x.advisor ? `Your advisor is <strong>${x.advisor}</strong>. ` : ""}${x.location ? `Please arrive at <strong>${x.location}</strong>. ` : ""}Please remove valuables, bring the vehicle key and service documents, and allow a few minutes for check-in. A calendar invitation is attached.`,
    sample: { vehicle: "2025 BMW X7", date: "August 14, 2026", time: "9:00 AM", advisor: "Jordan", location: "Main Service Centre" },
  },
  "service.appointment.reminder": {
    label: "Service Appointment Reminder",
    description: "Automatic 48-hour or 3-hour appointment reminder.",
    subject: (x) => `${d(x, "window", "Upcoming")}: your service appointment`,
    heading: () => "A reminder about your service appointment",
    body: (x) =>
      `Your <strong>${d(x, "service", "service")}</strong> appointment for the <strong>${d(x, "vehicle", "vehicle")}</strong> is on <strong>${d(x, "date", "the confirmed date")}</strong> at <strong>${d(x, "time", "the confirmed time")}</strong>. Please reply if anything has changed.`,
    sample: { window: "In 48 hours", vehicle: "2025 BMW X7", service: "maintenance", date: "August 14, 2026", time: "9:00 AM" },
  },
  "service.checkin.receipt": {
    label: "Digital Service Check-in Receipt",
    description: "Receipts the first recorded vehicle intake.",
    subject: (x) => `Checked in: ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Your vehicle is checked in",
    body: (x) =>
      `We have checked in your <strong>${d(x, "vehicle", "vehicle")}</strong>${x.mileage ? ` at <strong>${x.mileage}</strong>` : ""}. Recorded concerns: ${d(x, "concerns", "none noted")}.${x.condition ? ` Condition notes: ${x.condition}.` : ""}${x.advisor ? ` Your advisor is <strong>${x.advisor}</strong>.` : ""}`,
    sample: { vehicle: "2025 BMW X7", mileage: "42,000 km", concerns: "Brake noise", condition: "Half tank; minor scratch noted", advisor: "Jordan" },
  },
  "service.estimate.ready": {
    label: "Service Estimate Ready",
    description: "Provides a secure expiring whole-estimate decision link.",
    subject: (x) => `Your service estimate is ready — ${d(x, "total", "")}`,
    heading: () => "Please review your estimate",
    body: (x) => `Your estimate for the <strong>${d(x, "vehicle", "vehicle")}</strong> totals <strong>${d(x, "total", "")}</strong>. Review the read-only parts and labour breakdown, then approve or decline the whole estimate using the secure link. The link expires on ${d(x, "expires", "the date shown")}.`,
    cta: (x) => ({ label: "Review estimate", href: x.link }),
    sample: { vehicle: "2025 BMW X7", total: "GY$45,200", expires: "August 16, 2026", link: "https://example.com/service-estimate/token" },
  },
  "service.estimate.decision": {
    label: "Service Estimate Decision",
    description: "Confirms a customer's whole-estimate decision.",
    subject: (x) => `Estimate ${d(x, "decision", "decision received")}`,
    heading: () => "Your decision has been recorded",
    body: (x) => `We recorded your decision to <strong>${d(x, "decision", "respond to")}</strong> the <strong>${d(x, "total", "")}</strong> estimate for your <strong>${d(x, "vehicle", "vehicle")}</strong>. Your service advisor will take it from here.`,
    sample: { decision: "approve", total: "GY$45,200", vehicle: "2025 BMW X7" },
  },
  "service.quality.complete": {
    label: "Service Quality Check Complete",
    description: "Confirms completed work has reached quality/completion state.",
    subject: (x) => `Quality check complete — ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Work and quality checks are complete",
    body: (x) => `The work on your <strong>${d(x, "vehicle", "vehicle")}</strong> has been completed and recorded.${x.work ? ` Completed work: ${x.work}.` : ""} We are preparing the final handover details.`,
    sample: { vehicle: "2025 BMW X7", work: "Oil and filter service; brake inspection" },
  },
  "service.started": {
    label: "Service Work Started",
    description: "Tells the customer the workshop has begun their job.",
    subject: (x) => `Work has started on your ${d(x, "vehicle", "vehicle")}`,
    heading: () => "Your vehicle is in the workshop",
    body: (x) =>
      `Our technicians have started the <strong>${d(x, "service", "requested work")}</strong> on your <strong>${d(x, "vehicle", "vehicle")}</strong>. We'll keep you posted at every milestone and let you know the moment it's ready for pickup.`,
    cta: () => ({ label: "In expert hands" }),
    sample: { vehicle: "2025 BMW X7", service: "20,000 km service" },
  },
  "service.delayed": {
    label: "Service Delayed / Awaiting Parts",
    description:
      "Notifies the customer their job is paused — awaiting parts or carried to another day.",
    subject: (x) => `An update on your ${d(x, "vehicle", "vehicle")}`,
    heading: () => "A short pause on your service",
    body: (x) =>
      `The <strong>${d(x, "service", "work")}</strong> on your <strong>${d(x, "vehicle", "vehicle")}</strong> is briefly on hold${d(x, "reason", "") ? ` — ${d(x, "reason", "")}` : ""}.${x.newDate ? ` Work is now scheduled to continue on <strong>${x.newDate}</strong>.` : " We'll resume as soon as possible and keep you informed."} Nothing is needed from you — your Service Advisor is on top of it.`,
    cta: () => ({ label: "We'll keep you posted" }),
    sample: {
      vehicle: "2025 BMW X7",
      service: "brake overhaul",
      reason: "a required part is on its way",
      newDate: "August 15, 2026",
    },
  },
  "service.invoice.issued": {
    label: "Service Invoice",
    description:
      "Sends the customer their service invoice (PDF attached) when work is completed.",
    subject: (x) => `Your service invoice for ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Your vehicle is ready — invoice enclosed",
    body: (x) =>
      `Work on your <strong>${d(x, "vehicle", "vehicle")}</strong> is complete. Your invoice <strong>${d(x, "invoiceRef", "")}</strong> for <strong>${d(x, "total", "")}</strong> is attached as a PDF.${x.completedWork ? ` Completed work: ${x.completedWork}.` : ""}${x.recommendedMaintenance ? ` Recommended maintenance/notes: ${x.recommendedMaintenance}.` : ""} You can settle it at pickup — our team will have everything ready.`,
    cta: () => ({ label: "See you at pickup" }),
    sample: {
      name: "Alex Mensah",
      vehicle: "2025 BMW X7",
      invoiceRef: "SV-00012",
      total: "GYD 45,200",
      completedWork: "Oil and filter service",
      recommendedMaintenance: "Recheck front brakes in 5,000 km",
    },
  },
  "service.summary.management": {
    label: "Scheduled Services Summary (Internal)",
    description:
      "Recurring management digest of the upcoming days' booked services.",
    subject: (x) =>
      `Upcoming services: ${d(x, "count", "0")} booked ${d(x, "window", "in the next days")}`,
    heading: (x) => `${d(x, "count", "0")} services ${d(x, "window", "coming up")}`,
    body: (x) =>
      `Here is the workshop's forward schedule ${d(x, "window", "for the coming days")}:<br/><br/>${d(x, "rows", "No services are currently booked in this window.")}`,
    cta: () => ({ label: "Plan the workshop load" }),
    sample: {
      count: "3",
      window: "over the next 3 days",
      rows: "<strong>Aug 12</strong> — 2025 BMW X7, maintenance (Alex Mensah)<br/><strong>Aug 13</strong> — Toyota Hilux, repair (Priya Persaud)<br/><strong>Aug 14</strong> — Audi e-tron GT, inspection (Nana Adjei)",
    },
  },
  "collision.claim.action": {
    label: "Collision Claim Action (Internal)",
    description:
      "Routes collision claim handoffs, approvals and collection actions to the responsible dealership team.",
    subject: (x) =>
      `${d(x, "action", "Collision claim update")} — ${d(x, "claimRef", "claim")}`,
    heading: (x) => d(x, "action", "Collision claim needs attention"),
    body: (x) =>
      `<strong>${d(x, "claimRef", "Collision claim")}</strong> for ${d(x, "vehicle", "the vehicle")} is now <strong>${d(x, "status", "updated")}</strong>.<br/><br/>${d(x, "body", "Open AURA to review the claim and complete the next step.")}`,
    cta: (x) => ({
      label: "Open Collision Claims",
      ...(x.link ? { href: x.link } : {}),
    }),
    sample: {
      action: "Insurer sign-off required",
      claimRef: "Claim #68",
      vehicle: "2025 Toyota Hilux",
      status: "Quality Check",
      body: "Review the completed repair and record insurer sign-off.",
      link: "/service?tab=collision",
    },
  },
  // Task 269: daily lead-source report for General Managers.
  "leads.source.report.daily": {
    label: "Daily Lead Source Report (Internal)",
    description:
      "Morning report to General Managers: yesterday's new leads broken down by source.",
    subject: (x) =>
      `Lead source report — ${d(x, "total", "0")} lead${x.total === "1" ? "" : "s"} on ${d(x, "date", "yesterday")}`,
    heading: (x) => `${d(x, "total", "0")} new lead${x.total === "1" ? "" : "s"} yesterday`,
    body: (x) =>
      `${d(x, "topline", "Here is yesterday's lead flow.")}<br/><br/>${d(x, "rows", "No leads were captured in this period.")}`,
    cta: () => ({ label: "Start the day informed" }),
    sample: {
      date: "Aug 28, 2026",
      total: "12",
      change: "+20%",
      changeColor: "#1a7a3c",
      contacted: "7",
      priority: "2",
      trendRows: "",
      topline:
        "<strong>Facebook</strong> led the day with <strong>5 leads (42%)</strong>.",
      rows: "<strong>Facebook</strong> — 5 (42%)<br/><strong>Website</strong> — 4 (33%)<br/><strong>Walk-in</strong> — 3 (25%)",
      sourceTableRows: "",
      priorityRows: "",
    },
  },
};

/**
 * White-label branding injected into every rendered email. `name` replaces
 * the AURA wordmark and all "AURA" mentions inside template copy (via the
 * `__brand` data key); `logoSrc` (a `cid:` reference or data URI) renders the
 * dealership logo in the header. Both fall back to the default AURA branding.
 */
export type EmailBranding = {
  name?: string | null;
  logoSrc?: string | null;
};

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Detect the mime/extension of an uploaded logo from its magic bytes. */
export function sniffImageMime(buf: Buffer): { mime: string; ext: string } {
  if (buf.length > 2 && buf[0] === 0x89 && buf[1] === 0x50)
    return { mime: "image/png", ext: "png" };
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8)
    return { mime: "image/jpeg", ext: "jpg" };
  const head = buf.subarray(0, 5).toString("utf8");
  if (head.startsWith("RIFF")) return { mime: "image/webp", ext: "webp" };
  if (head.startsWith("<?xml") || head.startsWith("<svg"))
    return { mime: "image/svg+xml", ext: "svg" };
  if (head.startsWith("GIF8")) return { mime: "image/gif", ext: "gif" };
  return { mime: "image/png", ext: "png" };
}

// ---------------------------------------------------------------------------
// Per-dealer template overrides — {{field}} merge tokens
// ---------------------------------------------------------------------------

/**
 * The approved merge fields for a template: the keys of its sample data plus
 * the special `brand` token (the dealership's display name).
 */
export function templateMergeFields(template: EmailTemplate): string[] {
  return ["brand", ...Object.keys(TEMPLATE_DEFS[template].sample)];
}

/**
 * Returns the {{tokens}} referenced by `text` that are NOT in the approved
 * merge-field list for the template. Empty array = valid.
 */
export function invalidMergeTokens(
  template: EmailTemplate,
  text: string,
): string[] {
  const allowed = new Set(templateMergeFields(template));
  const bad = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    const token = m[1] ?? "";
    if (!allowed.has(token)) bad.add(token);
  }
  return [...bad];
}

/** Substitute {{field}} tokens from the render data ({{brand}} = __brand). */
function applyMergeTokens(text: string, x: TemplateData): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, token: string) => {
    if (token === "brand") return x["__brand"] ?? "AURA";
    return x[token] ?? "";
  });
}

/**
 * Customized copy for a template. Any null field falls back to the built-in
 * default. Values may contain approved {{field}} merge tokens.
 */
export type TemplateOverrideCopy = {
  subject?: string | null;
  heading?: string | null;
  body?: string | null;
  ctaLabel?: string | null;
};

/**
 * Load a dealer's enabled override for a template (null when none).
 * Never falls back to another dealer.
 */
export async function getTemplateOverride(
  dealerId: number,
  template: string,
): Promise<EmailTemplateOverride | null> {
  const [row] = await db
    .select()
    .from(emailTemplateOverridesTable)
    .where(
      and(
        eq(emailTemplateOverridesTable.dealerId, dealerId),
        eq(emailTemplateOverridesTable.templateKey, template),
        eq(emailTemplateOverridesTable.enabled, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function renderEmail(
  template: EmailTemplate,
  data: TemplateData,
  branding?: EmailBranding,
  override?: TemplateOverrideCopy | null,
): { subject: string; html: string } {
  const def = TEMPLATE_DEFS[template];
  // Strip markup characters — `__brand` flows into raw HTML template copy
  // (and plain-text subjects, so entity-escaping would render literally).
  const brandName = (branding?.name?.trim() || "").replace(/[<>]/g, "");
  // Templates reference the dealership via the `__brand` key; default AURA.
  const x: TemplateData = { ...data, __brand: brandName || "AURA" };
  // Dealer overrides: any non-empty override field replaces the default copy
  // (with {{field}} merge tokens substituted); empty/null falls back.
  const ovSubject = override?.subject?.trim();
  const ovHeading = override?.heading?.trim();
  const ovBody = override?.body?.trim();
  const ovCtaLabel = override?.ctaLabel?.trim();
  const subject = (ovSubject ? applyMergeTokens(ovSubject, x) : def.subject(x))
    .replace(/[\r\n]+/g, " ");
  const safeName = escapeHtml(brandName || "AURA Dealership");
  const headerHtml = branding?.logoSrc
    ? `<img src="${branding.logoSrc}" alt="${safeName}" style="display:block;max-height:56px;max-width:240px;height:auto;width:auto;border:0;" />`
    : brandName
      ? `<div style="font-size:22px;font-weight:700;letter-spacing:1px;color:#111111;">${escapeHtml(brandName)}</div>
            <div style="font-size:10px;letter-spacing:3px;color:#8a8a8a;text-transform:uppercase;margin-top:4px;">Automotive Dealership</div>`
      : `<div style="font-size:22px;font-weight:700;letter-spacing:1px;color:#111111;">AURA<span style="color:#e01313;">.OS</span></div>
            <div style="font-size:10px;letter-spacing:3px;color:#8a8a8a;text-transform:uppercase;margin-top:4px;">Dealership Operating System</div>`;
  if (template === "leads.source.report.daily" && !override) {
    const safeDate = escapeHtml(d(x, "date", "Yesterday"));
    const safeTotal = escapeHtml(d(x, "total", "0"));
    const safeChange = escapeHtml(d(x, "change", "0%"));
    const safeChangeColor = /^#[0-9a-f]{6}$/i.test(d(x, "changeColor", ""))
      ? d(x, "changeColor", "#1a2b4c")
      : "#1a2b4c";
    const safeContacted = escapeHtml(d(x, "contacted", "0"));
    const safePriority = escapeHtml(d(x, "priority", "0"));
    return {
      subject,
      html: `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background-color:#ffffff;border:1px solid #e6e6e6;border-radius:16px;overflow:hidden;">
        <tr><td style="height:5px;background:linear-gradient(90deg,#1fa34a 0%,#1fa34a 33%,#f5d800 33%,#f5d800 66%,#e01313 66%,#e01313 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:34px 32px 14px;">${headerHtml}</td>
        </tr>
        <tr>
          <td style="padding:18px 32px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="font-size:22px;font-weight:700;color:#1a2b4c;">Daily Leads Report</td>
              <td align="right" style="font-size:13px;color:#6b7280;white-space:nowrap;">${safeDate}</td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="25%" align="center" style="padding:12px;">
                  <div style="font-size:26px;font-weight:700;color:#1a2b4c;">${safeTotal}</div>
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Total Leads</div>
                </td>
                <td width="25%" align="center" style="padding:12px;border-left:1px solid #e5e7eb;">
                  <div style="font-size:26px;font-weight:700;color:${safeChangeColor};">${safeChange}</div>
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">vs. Prior Day</div>
                </td>
                <td width="25%" align="center" style="padding:12px;border-left:1px solid #e5e7eb;">
                  <div style="font-size:26px;font-weight:700;color:#1a2b4c;">${safeContacted}</div>
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Contacted</div>
                </td>
                <td width="25%" align="center" style="padding:12px;border-left:1px solid #e5e7eb;">
                  <div style="font-size:26px;font-weight:700;color:#b45309;">${safePriority}</div>
                  <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">High Priority</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px 8px;">
            <div style="font-size:15px;font-weight:700;color:#1a2b4c;margin-bottom:10px;">Leads — Last 7 Days</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${d(x, "trendRows", "")}</table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 8px;">
            <div style="font-size:15px;font-weight:700;color:#1a2b4c;margin-bottom:8px;">Leads by Source</div>
            <div style="font-size:13px;line-height:1.6;color:#374151;margin-bottom:14px;">${d(x, "topline", "Here is yesterday's lead flow.")}</div>
            ${d(x, "rows", "No leads were captured in this period.")}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
              <tr style="background:#f4f5f7;">
                <td style="padding:8px 10px;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">Source</td>
                <td align="center" style="padding:8px 10px;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">Leads</td>
                <td align="center" style="padding:8px 10px;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">Share</td>
              </tr>
              ${d(x, "sourceTableRows", "")}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 8px;">
            <div style="font-size:15px;font-weight:700;color:#1a2b4c;margin-bottom:10px;">Priority Leads Needing Follow-Up</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
              <tr style="background:#f4f5f7;">
                <td style="padding:8px 10px;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">Name</td>
                <td style="padding:8px 10px;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">Source</td>
                <td style="padding:8px 10px;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">Interest</td>
                <td align="center" style="padding:8px 10px;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">Status</td>
              </tr>
              ${d(x, "priorityRows", "")}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 32px 30px;">
            <div style="font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:14px;line-height:1.6;">
              This is an automated summary of leads captured across all channels for the previous dealership-local day.<br/>
              ${safeName} — Daily sales management report
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    };
  }
  // Built-in copy contains intentional markup, so escape payload values before
  // interpolating them. This covers all customer-entered lifecycle fields and
  // dealer override merge tokens without allowing markup injection.
  const safeX: TemplateData = Object.fromEntries(
    Object.entries(x).map(([key, value]) => [key, escapeHtml(value)]),
  );
  // Headings always end with a full stop for consistent punctuation.
  const headingRaw = (
    ovHeading ? applyMergeTokens(ovHeading, safeX) : def.heading(safeX)
  ).trim();
  const heading = /[.!?…]$/.test(headingRaw) ? headingRaw : `${headingRaw}.`;
  const body = ovBody ? applyMergeTokens(ovBody, safeX) : def.body(safeX);
  const ctaRaw = def.cta?.(safeX);
  // Button/CTA text is always upper-case.
  const cta = ctaRaw
    ? {
        ...ctaRaw,
        label: (ovCtaLabel
          ? applyMergeTokens(ovCtaLabel, safeX)
          : ctaRaw.label
        ).toUpperCase(),
      }
    : undefined;
  const footerName = escapeHtml(brandName || "AURA Dealership");
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e6e6e6;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="height:5px;background:linear-gradient(90deg,#1fa34a 0%,#1fa34a 33%,#f5d800 33%,#f5d800 66%,#e01313 66%,#e01313 100%);font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:36px 44px 8px;">
            ${headerHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:28px 44px 0;">
            <div style="font-size:26px;font-weight:600;color:#111111;line-height:1.3;">${heading}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 44px 0;">
            <div style="font-size:15px;color:#444444;line-height:1.7;">${body}</div>
          </td>
        </tr>
        ${
          cta
            ? `<tr><td style="padding:28px 44px 0;">
            ${
              cta.href
                ? `<a href="${cta.href}" style="display:inline-block;background-color:#111111;color:#ffffff;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:12px 26px;border-radius:999px;text-decoration:none;border-bottom:3px solid #1fa34a;">${cta.label}</a>`
                : `<div style="display:inline-block;background-color:#111111;color:#ffffff;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:12px 26px;border-radius:999px;border-bottom:3px solid #1fa34a;">${cta.label}</div>`
            }
          </td></tr>`
            : ""
        }
        <tr>
          <td style="padding:36px 44px 32px;">
            <div style="border-top:1px solid #e6e6e6;padding-top:20px;font-size:11px;color:#8a8a8a;line-height:1.6;">
              ${footerName} — Premium Automotive Sales Advisory<br/>
              You are receiving this because of your relationship with our showroom.
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Outbox — DB-backed queue with retry/backoff + idempotency for every
// outbound email AND WhatsApp message.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

/** Exponential backoff: 1 min, 2 min, 4 min… after each failed attempt. */
function backoffDate(attempts: number): Date {
  return new Date(Date.now() + Math.pow(2, Math.max(0, attempts - 1)) * 60_000);
}

export type EnqueueOptions = {
  template: EmailTemplate;
  to: string;
  dealerId: number;
  customerId?: number | null;
  leadId?: number | null;
  data?: TemplateData;
  /** Idempotency — a second enqueue with the same key is a no-op. */
  dedupeKey?: string;
  /** Scheduled send: worker won't touch the item before this time. */
  sendAt?: Date;
  /**
   * R6.4 cascade: internal user to notify In-App if this email terminally
   * fails (retry cap reached) — the guaranteed floor for customer-facing
   * sends. Stored in the payload so the worker can act on it.
   */
  notifyUserId?: number;
};

/**
 * Typed event API for other modules: enqueue a templated email.
 * The queue worker delivers it, retries with backoff, and logs everything.
 */
/** Lightweight branding lookup (no logo download) for subject rendering. */
async function getDealerBrandName(
  dealerId: number | null | undefined,
): Promise<string | null> {
  if (!dealerId) return null;
  try {
    const [row] = await db
      .select({
        name: dealersTable.name,
        brandName: dealersTable.brandName,
      })
      .from(dealersTable)
      .where(eq(dealersTable.id, dealerId))
      .limit(1);
    return row ? (row.brandName ?? row.name) : null;
  } catch {
    return null;
  }
}

/**
 * True when the recipient address belongs to a lead (or a lead's linked
 * customer) that has email communication switched OFF (`emailOptOut`).
 * Matching is by recipient address within the dealer, so it catches every
 * send path (quotes, invoices, delivery, agents, sweeps) without touching
 * internal staff mail, whose recipients are staff addresses.
 */
async function isRecipientEmailOptedOut(
  dealerId: number | null | undefined,
  to: string,
): Promise<boolean> {
  if (!dealerId || !to) return false;
  const addr = to.trim().toLowerCase();
  if (!addr) return false;
  try {
    const [row] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .leftJoin(customersTable, eq(leadsTable.customerId, customersTable.id))
      .where(
        and(
          eq(leadsTable.dealerId, dealerId),
          eq(leadsTable.emailOptOut, true),
          isNull(leadsTable.deletedAt),
          or(
            sql`lower(${leadsTable.email}) = ${addr}`,
            sql`lower(${customersTable.email}) = ${addr}`,
          ),
        ),
      )
      .limit(1);
    return Boolean(row);
  } catch (err) {
    logger.error({ err }, "email opt-out check failed (sending anyway)");
    return false;
  }
}

export async function enqueueEmail(opts: EnqueueOptions): Promise<EmailLog> {
  const { subject } = renderEmail(
    opts.template,
    opts.data ?? {},
    { name: await getDealerBrandName(opts.dealerId) },
    await getTemplateOverride(opts.dealerId, opts.template),
  );
  // Per-lead email kill switch: log the suppression for audit, never send.
  if (await isRecipientEmailOptedOut(opts.dealerId, opts.to)) {
    const [suppressed] = await db
      .insert(emailLogsTable)
      .values({
        dealerId: opts.dealerId,
        customerId: opts.customerId ?? null,
        leadId: opts.leadId ?? null,
        recipient: opts.to,
        subject,
        template: opts.template,
        channel: "email",
        status: "cancelled",
        payload: opts.data ?? {},
        // Suffixed so a suppressed event never consumes the real dedupe key:
        // if email is re-enabled later, a legitimate re-send still goes out.
        dedupeKey: opts.dedupeKey ? `${opts.dedupeKey}:suppressed` : null,
        lastError: "suppressed: email communication is off for this lead",
      })
      .onConflictDoNothing({ target: emailLogsTable.dedupeKey })
      .returning();
    if (suppressed) return suppressed;
    const [existing] = await db
      .select()
      .from(emailLogsTable)
      .where(eq(emailLogsTable.dedupeKey, opts.dedupeKey!));
    return existing!;
  }
  const [row] = await db
    .insert(emailLogsTable)
    .values({
      dealerId: opts.dealerId,
      customerId: opts.customerId ?? null,
      leadId: opts.leadId ?? null,
      recipient: opts.to,
      subject,
      template: opts.template,
      channel: "email",
      status: "queued",
      payload: {
        ...(opts.data ?? {}),
        ...(opts.notifyUserId != null
          ? { notifyUserId: String(opts.notifyUserId) }
          : {}),
      },
      dedupeKey: opts.dedupeKey ?? null,
      nextAttemptAt: opts.sendAt ?? null,
    })
    .onConflictDoNothing({ target: emailLogsTable.dedupeKey })
    .returning();
  if (!row) {
    // Duplicate dedupeKey — return the existing item (idempotent enqueue).
    const [existing] = await db
      .select()
      .from(emailLogsTable)
      .where(eq(emailLogsTable.dedupeKey, opts.dedupeKey!));
    return existing!;
  }
  // Kick the worker soon so sends feel immediate.
  setTimeout(() => void processQueue(), 50);
  return row;
}

export type EnqueueWhatsappOptions = {
  kind: WhatsappKind;
  to: string; // digits-only phone
  body: string;
  dealerId: number;
  leadId?: number | null;
  customerId?: number | null;
  /** Shown in the outbox log ("subject" column). */
  summary?: string;
  /** Recorded as the transcript actor once delivered (default "AURA Outbox"). */
  actor?: string;
  /** Only for the mandatory STOP/START acknowledgement generated by AURA. */
  allowOptOutConfirmation?: boolean;
  interactive?:
    | { type: "buttons"; buttons: WhatsappButton[] }
    | {
        type: "list";
        buttonLabel: string;
        sectionTitle: string;
        rows: WhatsappListRow[];
      };
  /**
   * A private document rebuilt by the worker and uploaded directly to Meta.
   * Quote PDFs intentionally never receive a public object-storage URL.
   */
  document?: {
    kind: "quote_pdf";
    filename: string;
    data: TemplateData;
  };
  dedupeKey?: string;
  sendAt?: Date;
  /**
   * R6.4 fallback cascade WhatsApp → Email → In-App: when the recipient has
   * opted out (or the send terminally fails), the same logical event is
   * re-enqueued as this email with a channel-suffixed dedupeKey so it is not
   * deduped against the failed/suppressed WhatsApp row.
   */
  fallbackEmail?: {
    to: string;
    template: EmailTemplate;
    data?: TemplateData;
  };
  /** Internal user notified In-App if every channel terminally fails. */
  notifyUserId?: number;
};

export type WhatsappOutboxDisposition =
  | "queued"
  | "already_sent"
  | "blocked";

/**
 * Translate a deduped outbox row into an honest API result. A retryable failed
 * row is still active; terminal failures and cancellations are blocked.
 */
export function whatsappOutboxDisposition(
  row: Pick<EmailLog, "status" | "attempts" | "nextAttemptAt">,
): WhatsappOutboxDisposition {
  if (row.status === "sent") return "already_sent";
  if (
    row.status === "queued" ||
    row.status === "processing" ||
    row.status === "sending" ||
    (row.status === "failed" &&
      row.attempts < MAX_ATTEMPTS &&
      row.nextAttemptAt != null)
  ) {
    return "queued";
  }
  return "blocked";
}

/** R6.4: true when the phone has an explicit WhatsApp opt-out on record. */
export async function isWhatsappOptedOut(
  dealerId: number,
  phone: string,
): Promise<boolean> {
  const digits = normalizeWhatsappPhone(phone);
  if (!digits) return false;
  const optedOutRows = await db
    .select({
      phone: whatsappConversationsTable.phone,
      optedOutAt: whatsappConversationsTable.optedOutAt,
    })
    .from(whatsappConversationsTable)
    .where(
      and(
        eq(whatsappConversationsTable.dealerId, dealerId),
        isNotNull(whatsappConversationsTable.optedOutAt),
      ),
    );
  return optedOutRows.some(
    (conversation) =>
      Boolean(conversation.optedOutAt) &&
      normalizeWhatsappPhone(conversation.phone) === digits,
  );
}

const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Meta permits free-form replies only for 24 hours after the last inbound message. */
export async function isWhatsappReplyWindowOpen(
  dealerId: number,
  phone: string,
  at = new Date(),
): Promise<boolean> {
  const canonical = normalizeWhatsappPhone(phone);
  if (!canonical) return false;
  const [lastInbound] = await db
    .select({ createdAt: whatsappMessagesTable.createdAt })
    .from(whatsappMessagesTable)
    .where(
      and(
        eq(whatsappMessagesTable.dealerId, dealerId),
        eq(whatsappMessagesTable.phone, canonical),
        eq(whatsappMessagesTable.direction, "in"),
      ),
    )
    .orderBy(desc(whatsappMessagesTable.createdAt))
    .limit(1);
  return Boolean(
    lastInbound &&
      lastInbound.createdAt.getTime() + WHATSAPP_REPLY_WINDOW_MS > at.getTime(),
  );
}

async function cancelledWhatsappLog(
  opts: EnqueueWhatsappOptions,
  recipient: string,
  reason: string,
): Promise<EmailLog> {
  // A temporary document-policy block (for example, a closed reply window)
  // must not consume the real send key forever. Once the customer replies,
  // the same quote can be enqueued under the unsuffixed key.
  const blockedDedupeKey =
    opts.document && opts.dedupeKey
      ? `${opts.dedupeKey}:blocked`
      : (opts.dedupeKey ?? null);
  const [inserted] = await db
    .insert(emailLogsTable)
    .values({
      dealerId: opts.dealerId,
      customerId: opts.customerId ?? null,
      leadId: opts.leadId ?? null,
      recipient,
      subject: opts.summary ?? opts.body.slice(0, 140),
      template: opts.kind,
      channel: "whatsapp",
      status: "cancelled",
      deliveryStatus: "cancelled",
      lastError: reason,
      payload: {
        body: opts.body,
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.interactive
          ? { interactiveJson: JSON.stringify(opts.interactive) }
          : {}),
        ...(opts.allowOptOutConfirmation
          ? { allowOptOutConfirmation: "true" }
          : {}),
        ...(opts.document
          ? {
              documentKind: opts.document.kind,
              documentFileName: opts.document.filename,
              documentDataJson: JSON.stringify(opts.document.data),
            }
          : {}),
      },
      dedupeKey: blockedDedupeKey,
    })
    .onConflictDoNothing({ target: emailLogsTable.dedupeKey })
    .returning();
  let row = inserted;
  if (!row && blockedDedupeKey) {
    const [existing] = await db
      .select()
      .from(emailLogsTable)
      .where(eq(emailLogsTable.dedupeKey, blockedDedupeKey));
    if (existing) return existing;
  }
  if (!row) {
    throw new Error("Unable to persist the blocked WhatsApp delivery");
  }

  if (normalizeWhatsappPhone(recipient)) {
    await recordWhatsappMessage({
      phone: recipient,
      direction: "out",
      body: opts.body,
      dealerId: opts.dealerId,
      leadId: opts.leadId ?? null,
      actor: opts.actor ?? "AURA Outbox",
      outboxId: row.id,
      deliveryStatus: "cancelled",
      deliveryError: reason,
    });
  }

  if (opts.fallbackEmail) {
    await enqueueEmail({
      template: opts.fallbackEmail.template,
      to: opts.fallbackEmail.to,
      dealerId: opts.dealerId,
      customerId: opts.customerId ?? null,
      leadId: opts.leadId ?? null,
      data: opts.fallbackEmail.data,
      dedupeKey: opts.dedupeKey ? `${opts.dedupeKey}:blockedEmail` : undefined,
      notifyUserId: opts.notifyUserId,
    });
  } else if (opts.notifyUserId != null) {
    await notifyUser({
      dealerId: opts.dealerId,
      userId: opts.notifyUserId,
      type: "channel.delivery.failed",
      title: "WhatsApp message blocked",
      body: `${opts.summary ?? opts.kind}: ${reason}`,
      entityType: "email_log",
      entityId: row.id,
    });
  }
  return row;
}

/**
 * Enqueue an outbound WhatsApp message through the same DB-backed outbox.
 * The worker sends it via the Meta transport, records the transcript, and
 * retries with backoff on failure — failures stay visible in the outbox log.
 */
export async function enqueueWhatsapp(
  opts: EnqueueWhatsappOptions,
): Promise<EmailLog> {
  const digits = normalizeWhatsappPhone(opts.to);
  if (!digits) {
    return cancelledWhatsappLog(
      opts,
      opts.to.replace(/\D/g, ""),
      "The recipient phone number is not a valid WhatsApp number.",
    );
  }

  // R6.4 opt-out enforcement at the enqueue boundary: a suppressed row is
  // still written (status "cancelled") so the outbox log shows WHY nothing
  // went out, then the cascade downgrades to Email (or In-App notice).
  if (
    !opts.allowOptOutConfirmation &&
    (await isWhatsappOptedOut(opts.dealerId, digits))
  ) {
    return cancelledWhatsappLog(
      opts,
      digits,
      "Recipient has opted out of WhatsApp (STOP).",
    );
  }

  const targetTime = opts.sendAt ?? new Date();
  if (!(await isWhatsappReplyWindowOpen(opts.dealerId, digits, targetTime))) {
    if (opts.document) {
      return cancelledWhatsappLog(
        opts,
        digits,
        "The 24-hour WhatsApp reply window is closed. Meta only allows this quote PDF after the customer sends a new message.",
      );
    }
    const channel = await getChannelByDealerId(opts.dealerId);
    if (!channel?.serviceTemplateName) {
      return cancelledWhatsappLog(
        opts,
        digits,
        "The 24-hour WhatsApp reply window is closed and no approved service template is configured.",
      );
    }
  }

  const [row] = await db
    .insert(emailLogsTable)
    .values({
      dealerId: opts.dealerId,
      customerId: opts.customerId ?? null,
      leadId: opts.leadId ?? null,
      recipient: digits,
      subject: opts.summary ?? opts.body.slice(0, 140),
      template: opts.kind,
      channel: "whatsapp",
      status: "queued",
      deliveryStatus: "queued",
      payload: {
        body: opts.body,
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.interactive
          ? { interactiveJson: JSON.stringify(opts.interactive) }
          : {}),
        ...(opts.allowOptOutConfirmation
          ? { allowOptOutConfirmation: "true" }
          : {}),
        ...(opts.document
          ? {
              documentKind: opts.document.kind,
              documentFileName: opts.document.filename,
              documentDataJson: JSON.stringify(opts.document.data),
            }
          : {}),
        ...(opts.fallbackEmail
          ? {
              fallbackEmailTo: opts.fallbackEmail.to,
              fallbackEmailTemplate: opts.fallbackEmail.template,
              fallbackEmailData: JSON.stringify(opts.fallbackEmail.data ?? {}),
            }
          : {}),
        ...(opts.notifyUserId != null
          ? { notifyUserId: String(opts.notifyUserId) }
          : {}),
      },
      dedupeKey: opts.dedupeKey ?? null,
      nextAttemptAt: opts.sendAt ?? null,
    })
    .onConflictDoNothing({ target: emailLogsTable.dedupeKey })
    .returning();
  if (!row) {
    const [existing] = await db
      .select()
      .from(emailLogsTable)
      .where(eq(emailLogsTable.dedupeKey, opts.dedupeKey!));
    return existing!;
  }
  await recordWhatsappMessage({
    phone: digits,
    direction: "out",
    body: opts.body,
    dealerId: opts.dealerId,
    leadId: opts.leadId ?? null,
    actor: opts.actor ?? "AURA Outbox",
    outboxId: row.id,
    deliveryStatus: "queued",
  });
  setTimeout(() => void processQueue(), 50);
  return row;
}

export function isKnownTemplate(key: string): key is EmailTemplate {
  return (EMAIL_TEMPLATES as readonly string[]).includes(key);
}

let processing = false;
const OUTBOX_CLAIM_LEASE_MS = 2 * 60 * 1000;
const OUTBOX_PROVIDER_RECEIPT_TIMEOUT_MS = 30 * 60 * 1000;

async function markQuoteDelivered(
  item: EmailLog,
  sentVia: "email" | "WhatsApp PDF",
): Promise<void> {
  let payload = item.payload ?? {};
  if (item.channel === "whatsapp" && payload.documentDataJson) {
    try {
      payload = {
        ...payload,
        ...(JSON.parse(payload.documentDataJson) as Record<string, string>),
      };
    } catch {
      return;
    }
  }
  const quoteId = Number(payload.quoteId);
  const leadId = Number(payload.leadId ?? item.leadId);
  if (!Number.isInteger(quoteId) || !Number.isInteger(leadId)) return;
  const sentAt = new Date();
  await db.transaction(async (tx) => {
    const [storedQuote] = await tx
      .select()
      .from(quotesTable)
      .where(and(
        eq(quotesTable.id, quoteId),
        eq(quotesTable.leadId, leadId),
        eq(quotesTable.dealerId, item.dealerId),
      ))
      .for("update");
    if (!storedQuote) return;
    const [newlySent] = storedQuote.sentAt
      ? []
      : await tx
          .update(quotesTable)
          .set({ sentAt, sentVia })
          .where(and(
            eq(quotesTable.id, quoteId),
            eq(quotesTable.leadId, leadId),
            eq(quotesTable.dealerId, item.dealerId),
            isNull(quotesTable.sentAt),
          ))
          .returning();
    // This runs even for an already-sent quote, repairing any historical split
    // where the quote was stamped but the lead flag was not.
    await tx
      .update(leadsTable)
      .set({ quotationSent: true })
      .where(and(
        eq(leadsTable.id, leadId),
        eq(leadsTable.dealerId, item.dealerId),
      ));
    if (!newlySent) return;
    await tx.insert(timelineEventsTable).values({
      dealerId: item.dealerId,
      customerId: item.customerId,
      domain: "leads",
      kind: "quote_sent",
      title: `Code ${newlySent.quoteNumber} sent via ${sentVia}`,
      detail: `Rev ${newlySent.version} was confirmed sent to the customer.`,
      actor: sentVia === "email" ? "Email Engine" : "WhatsApp Engine",
      isAgent: true,
      refType: "lead",
      refId: leadId,
    });
  });
}

/** Items ready for a (re)try: queued or retryable-failed, past their backoff time. */
function readyFilter(channel: "email" | "whatsapp") {
  return and(
    or(
      eq(emailLogsTable.status, "queued"),
      and(
        eq(emailLogsTable.status, "failed"),
        lt(emailLogsTable.attempts, MAX_ATTEMPTS),
      ),
      ...(channel === "whatsapp"
        ? [eq(emailLogsTable.status, "processing")]
        : []),
    ),
    eq(emailLogsTable.channel, channel),
    or(
      isNull(emailLogsTable.nextAttemptAt),
      lte(emailLogsTable.nextAttemptAt, new Date()),
    ),
  );
}

/** Atomic cross-process claim used by every WhatsApp queue worker. */
export async function claimWhatsappOutboxItem(
  id: number,
): Promise<EmailLog | null> {
  const [claimed] = await db
    .update(emailLogsTable)
    .set({
      status: "processing",
      nextAttemptAt: new Date(Date.now() + OUTBOX_CLAIM_LEASE_MS),
    })
    .where(
      and(
        eq(emailLogsTable.id, id),
        readyFilter("whatsapp"),
      ),
    )
    .returning();
  return claimed ?? null;
}

/** Mark an item failed and schedule its next retry with exponential backoff. */
async function markFailed(
  item: EmailLog,
  attempts: number,
  message: string,
  expectedStatus = "sending",
) {
  const terminal = attempts >= MAX_ATTEMPTS;
  const [failed] = await db
    .update(emailLogsTable)
    .set({
      status: "failed",
      attempts,
      deliveryStatus: terminal ? "failed" : "queued",
      lastError: message,
      nextAttemptAt: terminal ? null : backoffDate(attempts),
    })
    .where(
      and(
        eq(emailLogsTable.id, item.id),
        eq(emailLogsTable.status, expectedStatus),
      ),
    )
    .returning({ id: emailLogsTable.id });
  if (!failed) return;
  if (item.channel === "whatsapp") {
    await updateWhatsappDeliveryStatus({
      dealerId: item.dealerId,
      outboxId: item.id,
      status: terminal ? "failed" : "queued",
      error: terminal
        ? message
        : `${message} Retrying automatically (${attempts}/${MAX_ATTEMPTS}).`,
    });
  }
  if (!terminal) return;

  // R6.4 terminal-failure cascade: WhatsApp → Email → In-App.
  try {
    const payload = item.payload ?? {};
    const notifyUserId = payload.notifyUserId
      ? Number(payload.notifyUserId)
      : null;
    if (
      item.channel === "whatsapp" &&
      payload.fallbackEmailTo &&
      payload.fallbackEmailTemplate &&
      isKnownTemplate(payload.fallbackEmailTemplate)
    ) {
      let data: TemplateData = {};
      try {
        data = JSON.parse(payload.fallbackEmailData ?? "{}") as TemplateData;
      } catch {
        // ignore malformed fallback data — send with empty data
      }
      await enqueueEmail({
        template: payload.fallbackEmailTemplate,
        to: payload.fallbackEmailTo,
        dealerId: item.dealerId,
        customerId: item.customerId,
        leadId: item.leadId,
        data,
        dedupeKey: item.dedupeKey ? `${item.dedupeKey}:fallbackEmail` : undefined,
        notifyUserId: notifyUserId ?? undefined,
      });
      logger.info(
        { id: item.id, dedupeKey: item.dedupeKey },
        "whatsapp terminally failed — fallback email enqueued",
      );
    } else if (notifyUserId != null && Number.isFinite(notifyUserId)) {
      await notifyUser({
        dealerId: item.dealerId,
        userId: notifyUserId,
        type: "channel.delivery.failed",
        title: `${item.channel === "whatsapp" ? "WhatsApp" : "Email"} delivery failed`,
        body: `"${item.subject}" to ${item.recipient} failed after ${attempts} attempts: ${message}. Reach out manually or retry from the outbox.`,
        link: "/settings/emails",
        entityType: "email_log",
        entityId: item.id,
      });
      logger.info(
        { id: item.id, notifyUserId },
        "terminal delivery failure — in-app notice created",
      );
    }
    if (item.customerId) {
      await db.insert(timelineEventsTable).values({
        dealerId: item.dealerId,
        customerId: item.customerId,
        domain: "system",
        kind: "delivery_failed",
        title: `${item.channel === "whatsapp" ? "WhatsApp" : "Email"} delivery failed (${attempts} attempts)`,
        detail: `"${item.subject}" to ${item.recipient}: ${message}`,
        actor: "AURA Outbox",
        refType: "email_log",
        refId: item.id,
      });
    }
  } catch (err) {
    logger.error({ err, id: item.id }, "terminal-failure cascade failed");
  }
}

/** Cancel a queued message when policy changed after enqueue (STOP/window close). */
async function cancelQueuedWhatsapp(item: EmailLog, reason: string): Promise<void> {
  const releasedDedupeKey =
    item.payload?.documentKind === "quote_pdf" && item.dedupeKey
      ? `${item.dedupeKey}:blocked:${item.id}`
      : item.dedupeKey;
  const [cancelled] = await db
    .update(emailLogsTable)
    .set({
      status: "cancelled",
      deliveryStatus: "cancelled",
      lastError: reason,
      nextAttemptAt: null,
      dedupeKey: releasedDedupeKey,
    })
    .where(
      and(
        eq(emailLogsTable.id, item.id),
        eq(emailLogsTable.status, "processing"),
      ),
    )
    .returning({ id: emailLogsTable.id });
  if (!cancelled) return;
  await updateWhatsappDeliveryStatus({
    dealerId: item.dealerId,
    outboxId: item.id,
    status: "cancelled",
    error: reason,
  });

  const payload = item.payload ?? {};
  const notifyUserId = payload.notifyUserId
    ? Number(payload.notifyUserId)
    : null;
  if (
    payload.fallbackEmailTo &&
    payload.fallbackEmailTemplate &&
    isKnownTemplate(payload.fallbackEmailTemplate)
  ) {
    let data: TemplateData = {};
    try {
      data = JSON.parse(payload.fallbackEmailData ?? "{}") as TemplateData;
    } catch {
      // Send the fallback without optional template data.
    }
    await enqueueEmail({
      template: payload.fallbackEmailTemplate,
      to: payload.fallbackEmailTo,
      dealerId: item.dealerId,
      customerId: item.customerId,
      leadId: item.leadId,
      data,
      dedupeKey: item.dedupeKey ? `${item.dedupeKey}:blockedEmail` : undefined,
      notifyUserId: notifyUserId ?? undefined,
    });
  } else if (notifyUserId != null && Number.isFinite(notifyUserId)) {
    await notifyUser({
      dealerId: item.dealerId,
      userId: notifyUserId,
      type: "channel.delivery.failed",
      title: "WhatsApp message blocked",
      body: `"${item.subject}" to ${item.recipient} was not sent: ${reason}`,
      link: "/settings/emails",
      entityType: "email_log",
      entityId: item.id,
    });
  }
}

async function processWhatsappQueue(): Promise<void> {
  // A Meta request that never produced either a response or a correlated
  // receipt has an unknown outcome. Fail it terminally instead of blindly
  // resending a message the customer may already have received.
  const staleSending = await db
    .select()
    .from(emailLogsTable)
    .where(
      and(
        eq(emailLogsTable.channel, "whatsapp"),
        eq(emailLogsTable.status, "sending"),
        lte(emailLogsTable.nextAttemptAt, new Date()),
      ),
    )
    .limit(10);
  for (const stale of staleSending) {
    await markFailed(
      stale,
      MAX_ATTEMPTS,
      "Provider request outcome is unknown after the receipt timeout; automatic resend was suppressed to prevent a duplicate customer message.",
      "sending",
    );
  }

  const pending = await db
    .select()
    .from(emailLogsTable)
    .where(readyFilter("whatsapp"))
    .limit(10);
  if (pending.length === 0) return;

  for (const selected of pending) {
    // Cross-process compare-and-set claim. Only one worker may own a row.
    // An expired "processing" lease is safe to reclaim because the row is
    // moved to "sending" immediately before the external Meta request.
    const claimed = await claimWhatsappOutboxItem(selected.id);
    if (!claimed) continue;
    let item = claimed;
    const attempts = item.attempts + 1;

    if (
      item.payload?.allowOptOutConfirmation !== "true" &&
      (await isWhatsappOptedOut(item.dealerId, item.recipient))
    ) {
      await cancelQueuedWhatsapp(
        item,
        "Recipient opted out of WhatsApp after this message was queued.",
      );
      continue;
    }

    let sendStarted = false;
    try {
      // Resolve the Meta channel for this item's dealer (DB first, then env fallback).
      const dealerChannel =
        item.dealerId != null ? await getChannelByDealerId(item.dealerId) : null;
      if (!dealerChannel) {
        throw new Error(
          "WhatsApp is not configured or is paused for this dealership.",
        );
      }
      const body = item.payload?.body ?? "";
      const insideReplyWindow = await isWhatsappReplyWindowOpen(
        item.dealerId,
        item.recipient,
      );
      const isQuoteDocument = item.payload?.documentKind === "quote_pdf";
      if (!insideReplyWindow && isQuoteDocument) {
        await cancelQueuedWhatsapp(
          item,
          "The 24-hour WhatsApp reply window closed before the quote PDF could be delivered. Ask the customer to send a new message, then retry.",
        );
        continue;
      }
      if (!insideReplyWindow && !dealerChannel.serviceTemplateName) {
        await cancelQueuedWhatsapp(
          item,
          "The 24-hour WhatsApp reply window closed before delivery and no approved service template is configured.",
        );
        continue;
      }
      let interactive:
        | NonNullable<EnqueueWhatsappOptions["interactive"]>
        | null = null;
      if (item.payload?.interactiveJson) {
        try {
          interactive = JSON.parse(
            item.payload.interactiveJson,
          ) as NonNullable<EnqueueWhatsappOptions["interactive"]>;
        } catch {
          throw new Error("Queued WhatsApp interactive payload is invalid");
        }
      }
      let documentMediaId: string | null = null;
      let documentFileName: string | null = null;
      if (isQuoteDocument) {
        if (!item.payload?.documentDataJson) {
          throw new WhatsappProviderSendError(
            "Queued WhatsApp quote PDF data is missing",
            "terminal_rejection",
          );
        }
        let quoteData: TemplateData;
        try {
          quoteData = JSON.parse(item.payload.documentDataJson) as TemplateData;
        } catch {
          throw new WhatsappProviderSendError(
            "Queued WhatsApp quote PDF data is invalid",
            "terminal_rejection",
          );
        }
        const branding = await getDealerPdfBranding(item.dealerId);
        const pdf = await buildQuotePdf(
          quoteData,
          await dealerTimezone(item.dealerId),
          branding.logo,
        );
        const fallbackRef = (quoteData.quoteRef ?? `Q-${item.id}`).replace(
          /[^A-Za-z0-9-]/g,
          "",
        );
        const filePrefix =
          (branding.displayName ?? "AURA").replace(/[^A-Za-z0-9-]/g, "") ||
          "AURA";
        documentFileName =
          item.payload.documentFileName ||
          `${filePrefix}-Quote-${fallbackRef}.pdf`;
        documentMediaId = await uploadWhatsappDocument(dealerChannel, {
          bytes: new Uint8Array(pdf),
          filename: documentFileName,
          mimeType: "application/pdf",
        });
      }
      const [sending] = await db
        .update(emailLogsTable)
        .set({
          status: "sending",
          attempts,
          nextAttemptAt: new Date(
            Date.now() + OUTBOX_PROVIDER_RECEIPT_TIMEOUT_MS,
          ),
          lastError:
            "Awaiting the provider response or a correlated delivery receipt.",
        })
        .where(
          and(
            eq(emailLogsTable.id, item.id),
            eq(emailLogsTable.status, "processing"),
          ),
        )
        .returning();
      if (!sending) continue;
      item = sending;
      sendStarted = true;
      const correlationId = `aura-outbox:${item.id}`;
      const result = documentMediaId && documentFileName
        ? await sendWhatsappDocument(
            dealerChannel,
            item.recipient,
            {
              mediaId: documentMediaId,
              filename: documentFileName,
              caption: body,
            },
            correlationId,
          )
        : !insideReplyWindow
        ? await sendWhatsappTemplate(dealerChannel, item.recipient, {
            name: dealerChannel.serviceTemplateName!,
            language: dealerChannel.serviceTemplateLanguage,
            body,
          }, correlationId)
        : interactive?.type === "buttons"
          ? await sendWhatsappButtons(
              dealerChannel,
              item.recipient,
              body,
              interactive.buttons,
              correlationId,
            )
          : interactive?.type === "list"
            ? await sendWhatsappList(dealerChannel, item.recipient, {
                body,
                buttonLabel: interactive.buttonLabel,
                sectionTitle: interactive.sectionTitle,
                rows: interactive.rows,
              }, correlationId)
            : await sendWhatsappText(
                dealerChannel,
                item.recipient,
                body,
                correlationId,
              );
      await db
        .update(emailLogsTable)
        .set({
          status: "sent",
          deliveryStatus: "accepted",
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          lastError: null,
          nextAttemptAt: null,
        })
        .where(
          and(
            eq(emailLogsTable.id, item.id),
            eq(emailLogsTable.status, "sending"),
          ),
        );
      await updateWhatsappDeliveryStatus({
        dealerId: item.dealerId,
        outboxId: item.id,
        providerMessageId: result.providerMessageId,
        status: "accepted",
      });
      await markQuoteDelivered(item, "WhatsApp PDF");
      logger.info(
        {
          id: item.id,
          kind: item.template,
          mode: documentMediaId
            ? "document"
            : insideReplyWindow
              ? "text"
              : "template",
        },
        "whatsapp accepted by provider",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const disposition = whatsappSendFailureDisposition(err);
      if (
        sendStarted &&
        (disposition === "uncertain" || disposition == null)
      ) {
        const uncertainty =
          `${message}. Waiting for the correlated Meta receipt; automatic retry is suppressed.`.slice(
            0,
            1000,
          );
        await db
          .update(emailLogsTable)
          .set({ lastError: uncertainty })
          .where(
            and(
              eq(emailLogsTable.id, item.id),
              eq(emailLogsTable.status, "sending"),
            ),
          );
        await updateWhatsappDeliveryStatus({
          dealerId: item.dealerId,
          outboxId: item.id,
          status: "queued",
          error: uncertainty,
        });
        logger.warn(
          { err, id: item.id },
          "whatsapp send outcome unknown; waiting for receipt without retry",
        );
        continue;
      }
      await markFailed(
        item,
        disposition === "terminal_rejection" ? MAX_ATTEMPTS : attempts,
        message,
        sendStarted ? "sending" : "processing",
      );
      logger.error({ err, id: item.id }, "whatsapp send failed");
    }
  }
}

export async function processQueue(): Promise<void> {
  // Test seam: verification suites that enqueue fixture emails set this so
  // no outbox pass (email or WhatsApp, fixture or otherwise) runs in their
  // process. The real server never sets it.
  if (process.env.OUTBOX_WORKER_DISABLED === "1") return;
  if (processing) return;
  processing = true;
  try {
    await processWhatsappQueue();
  } catch (err) {
    logger.error({ err }, "whatsapp outbox pass failed");
  }
  try {
    const pending = await db
      .select()
      .from(emailLogsTable)
      .where(readyFilter("email"))
      .limit(10);
    if (pending.length === 0) return;

    // Per-dealer SMTP resolution cached per pass. NO global fallback: a
    // dealer without a working connection has its items terminally skipped.
    const smtpCache = new Map<
      number,
      Awaited<ReturnType<typeof resolveDealerSmtp>>
    >();
    const smtpFor = async (dealerId: number) => {
      const hit = smtpCache.get(dealerId);
      if (hit) return hit;
      const r = await resolveDealerSmtp(dealerId);
      smtpCache.set(dealerId, r);
      return r;
    };
    // Branding (incl. logo bytes from object storage) cached per pass so a
    // burst of emails for the same dealer doesn't re-download the logo.
    const brandCache = new Map<
      number,
      Awaited<ReturnType<typeof getDealerPdfBranding>>
    >();
    const brandingFor = async (dealerId: number) => {
      const hit = brandCache.get(dealerId);
      if (hit) return hit;
      const b = await getDealerPdfBranding(dealerId);
      brandCache.set(dealerId, b);
      return b;
    };
    for (const selected of pending) {
      // Cross-process compare-and-set claim (same pattern as the WhatsApp
      // worker): only the worker that moves the row queued/failed→sending
      // owns it. A second process selecting the same row gets 0 updates and
      // skips — no duplicate sends through the dealer transport.
      const [item] = await db
        .update(emailLogsTable)
        .set({ status: "sending", attempts: selected.attempts + 1 })
        .where(
          and(
            eq(emailLogsTable.id, selected.id),
            eq(emailLogsTable.status, selected.status),
            eq(emailLogsTable.attempts, selected.attempts),
          ),
        )
        .returning();
      if (!item) continue; // another worker claimed it
      // Scheduled service reminders are revalidated after the outbox CAS and
      // immediately before transport. A cancellation, stage change, or
      // reschedule therefore cannot leak a stale reminder even if it raced
      // the periodic queue selection.
      if (item.template === "service.appointment.reminder") {
        const orderId = Number(item.payload?.serviceOrderId);
        const expected = item.payload?.reminderScheduledAt;
        const [current] = Number.isInteger(orderId)
          ? await db
              .select({
                status: serviceOrdersTable.status,
                scheduledAt: jobCardsTable.scheduledAt,
              })
              .from(serviceOrdersTable)
              .innerJoin(
                jobCardsTable,
                and(
                  eq(jobCardsTable.serviceOrderId, serviceOrdersTable.id),
                  eq(jobCardsTable.dealerId, serviceOrdersTable.dealerId),
                ),
              )
              .where(
                and(
                  eq(serviceOrdersTable.id, orderId),
                  eq(serviceOrdersTable.dealerId, item.dealerId),
                ),
              )
              .limit(1)
          : [];
        if (
          !current ||
          current.status !== "acknowledged" ||
          !current.scheduledAt ||
          current.scheduledAt.toISOString() !== expected
        ) {
          await db
            .update(emailLogsTable)
            .set({ status: "cancelled", nextAttemptAt: null })
            .where(eq(emailLogsTable.id, item.id));
          continue;
        }
      }
      // Consent recheck at send time: opt-out may have been enabled after
      // this row was queued (or between scheduled retries) — never deliver.
      if (await isRecipientEmailOptedOut(item.dealerId, item.recipient)) {
        await db
          .update(emailLogsTable)
          .set({
            status: "cancelled",
            lastError:
              "suppressed: email communication is off for this lead",
          })
          .where(eq(emailLogsTable.id, item.id));
        continue;
      }
      // Resolve the OWNING dealer's SMTP connection. Unconfigured/disabled
      // dealers get a terminal, non-retrying skip — never another dealer's
      // sender, never a global credential.
      const smtp = await smtpFor(item.dealerId);
      if (!smtp.ok) {
        await db
          .update(emailLogsTable)
          .set({
            status: "cancelled",
            lastError: smtpSkipMessage(smtp.reason),
          })
          .where(eq(emailLogsTable.id, item.id));
        logger.info(
          { id: item.id, dealerId: item.dealerId, reason: smtp.reason },
          "email skipped: dealer SMTP unavailable",
        );
        continue;
      }
      try {
        // Per-dealer white-label branding: header logo (inline CID), display
        // name in copy/from-line. Falls back to AURA when unconfigured.
        const branding = await brandingFor(item.dealerId);
        const logo = branding.logo;
        // White-label attachment filename prefix (e.g. "GTAutomotive-Invoice-…").
        const filePrefix =
          (branding.displayName ?? "").replace(/[^A-Za-z0-9]/g, "") || "AURA";
        const override = await getTemplateOverride(
          item.dealerId,
          item.template,
        );
        const { subject, html } = renderEmail(
          item.template as EmailTemplate,
          item.payload ?? {},
          { name: branding.displayName, logoSrc: logo ? "cid:dealer-logo" : null },
          override,
        );
        let attachments:
          | { filename: string; content: Buffer; contentType: string; cid?: string }[]
          | undefined;
        if (item.template === "invoice.generated") {
          const pdf = await buildInvoicePdfFromPayload(
            item.payload ?? {},
            await dealerTimezone(item.dealerId),
            branding,
          );
          const ref = (item.payload?.invoiceNumber ?? `INV-${item.id}`).replace(
            /[^A-Za-z0-9-]/g,
            "",
          );
          attachments = [
            {
              filename: `${filePrefix}-Invoice-${ref}.pdf`,
              content: pdf,
              contentType: "application/pdf",
            },
          ];
        }
        if (item.template === "payment_received" && item.payload?.receiptId) {
          const [receipt] = await db
            .select()
            .from(receiptsTable)
            .where(
              and(
                eq(receiptsTable.id, Number(item.payload.receiptId)),
                eq(receiptsTable.dealerId, item.dealerId),
              ),
            );
          if (receipt) {
            const pdf = await buildReceiptPdf(
              receipt,
              await dealerTimezone(item.dealerId),
              branding,
            );
            attachments = [
              {
                filename: `${filePrefix}-Receipt-${receipt.receiptNumber.replace(/[^A-Za-z0-9-]/g, "")}.pdf`,
                content: pdf,
                contentType: "application/pdf",
              },
            ];
          }
        }
        if (
          item.template === "service.invoice.issued" &&
          item.payload?.serviceInvoiceId
        ) {
          const [svcInvoice] = await db
            .select()
            .from(serviceInvoicesTable)
            .where(
              and(
                eq(serviceInvoicesTable.id, Number(item.payload.serviceInvoiceId)),
                eq(serviceInvoicesTable.dealerId, item.dealerId),
              ),
            );
          if (svcInvoice) {
            const pdf = await buildServiceInvoicePdf(
              svcInvoice,
              1,
              await dealerTimezone(item.dealerId),
              branding,
            );
            const ref = `SV-${String(svcInvoice.id).padStart(5, "0")}`;
            attachments = [
              {
                filename: `${filePrefix}-ServiceInvoice-${ref}.pdf`,
                content: pdf,
                contentType: "application/pdf",
              },
            ];
          }
        }
        if (item.template === "warranty.document" && item.payload?.deliveryId) {
          const doc = await buildWarrantyBookletForDelivery(
            Number(item.payload.deliveryId),
            item.dealerId,
          );
          if (!doc) throw new Error("warranty booklet delivery not found");
          attachments = [
            {
              filename: `${filePrefix}-Warranty-Booklet.pdf`,
              content: doc.pdf,
              contentType: "application/pdf",
            },
          ];
        }
        if (item.template === "vehicle_quote") {
          const pdf = await buildQuotePdf(
            item.payload ?? {},
            await dealerTimezone(item.dealerId),
            branding.logo,
          );
          const ref = (item.payload?.quoteRef ?? `Q-${item.id}`).replace(
            /[^A-Za-z0-9-]/g,
            "",
          );
          attachments = [
            {
              filename: `${filePrefix}-Quote-${ref}.pdf`,
              content: pdf,
              contentType: "application/pdf",
            },
          ];
        }
        // Calendar invite — booked test drives land on the customer's and
        // the lead owner's calendars (rebuilt from the payload each attempt).
        let icalEvent:
          | { filename: string; method: string; content: string }
          | undefined;
        if (
          item.template === "test_drive_confirmation" ||
          item.template === "test_drive_owner_invite" ||
          item.template === "service.appointment.confirmed"
        ) {
          try {
            const ics =
              item.template === "service.appointment.confirmed"
                ? serviceIcsFromPayload({
                    ...(item.payload ?? {}),
                    organizerEmail: smtp.fromEmail,
                  })
                : testDriveIcsFromPayload(item.payload ?? {});
            if (ics) {
              icalEvent = {
                filename:
                  item.template === "service.appointment.confirmed"
                    ? "service-appointment.ics"
                    : "test-drive.ics",
                method: "REQUEST",
                content: ics,
              };
            }
          } catch (err) {
            logger.warn(
              { err, emailId: item.id },
              "calendar invite build failed — sending without it",
            );
          }
        }
        if (logo) {
          const { mime, ext } = sniffImageMime(logo);
          attachments = [
            ...(attachments ?? []),
            {
              filename: `logo.${ext}`,
              content: logo,
              contentType: mime,
              cid: "dealer-logo",
            },
          ];
        }
        const fromName = (branding.displayName ?? "AURA Dealership").replace(
          /"/g,
          "",
        );
        const sendResult = await smtp.transport.sendMail({
          from: `"${(smtp.fromName ?? fromName).replace(/"/g, "")}" <${smtp.fromEmail}>`,
          ...(smtp.replyTo ? { replyTo: smtp.replyTo } : {}),
          to: item.recipient,
          subject,
          html,
          // Marks system-originated mail so the Gmail intake agent never
          // re-ingests our own outbound (quotes, reminders, tests) as leads.
          headers: { [SYSTEM_MAIL_HEADER]: "1" },
          ...(attachments ? { attachments } : {}),
          ...(icalEvent ? { icalEvent } : {}),
        });
        const intendedRecipient = item.recipient.trim().toLowerCase();
        const accepted = (sendResult.accepted ?? []).some(
          (recipient: unknown) =>
            String(recipient).trim().toLowerCase() === intendedRecipient,
        );
        if (!accepted) {
          throw new Error("SMTP provider did not accept the intended recipient");
        }
        await db
          .update(emailLogsTable)
          .set({
            status: "sent",
            deliveryStatus: "accepted",
            sentAt: new Date(),
            lastError: null,
          })
          .where(eq(emailLogsTable.id, item.id));
        await markQuoteDelivered(item, "email");
        if (item.customerId) {
          await db.insert(timelineEventsTable).values({
            dealerId: item.dealerId,
            customerId: item.customerId,
            domain: "system",
            kind: "email_sent",
            title: `Email sent: ${subject}`,
            detail: `Template “${TEMPLATE_DEFS[item.template as EmailTemplate]?.label ?? item.template}” delivered to ${item.recipient}.`,
            actor: "Email Engine",
            isAgent: true,
            refType: "email",
            refId: item.id,
          });
        }
        logger.info({ id: item.id, template: item.template }, "email sent");
      } catch (err) {
        // Never persist or log raw SMTP error text — server responses can
        // echo credential material. Store/log only the classified message.
        const safe = sanitizeSmtpError(err);
        await markFailed(item, item.attempts, safe.message);
        logger.error(
          { id: item.id, dealerId: item.dealerId, smtpErrorCode: safe.code },
          "email send failed",
        );
      }
    }
  } finally {
    processing = false;
  }
}

// ---------------------------------------------------------------------------
// Task due-date reminders — due-soon (within 24h) and overdue, once each
// ---------------------------------------------------------------------------

export async function processTaskReminders(): Promise<void> {
  const now = new Date();

  const candidates = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        ne(tasksTable.status, "done"),
        isNotNull(tasksTable.dueDate),
        isNotNull(tasksTable.assigneeUserId),
        or(
          isNull(tasksTable.dueSoonNotifiedAt),
          isNull(tasksTable.overdueNotifiedAt),
        ),
      ),
    );

  for (const task of candidates) {
    const tz = await dealerTimezone(task.dealerId);
    const today = zonedDayKey(now, tz);
    const tomorrow = zonedAddDays(now, tz, 1);
    if (task.dueDate! > tomorrow) continue;
    const assigneeId = task.assigneeUserId!;
    const dueDate = task.dueDate!;
    try {
      if (dueDate < today && !task.overdueNotifiedAt) {
        await notifyUser({
          userId: assigneeId,
          dealerId: task.dealerId,
          type: "task",
          title: `Task overdue: ${task.title}`,
          body: `This ${task.priority}-priority task was due ${dueDate} and is still ${task.status === "in_progress" ? "in progress" : "open"}.`,
          link: "/tasks",
        });
        await db
          .update(tasksTable)
          .set({
            overdueNotifiedAt: now,
            // If it slipped past due before a due-soon reminder fired, don't
            // send a redundant "due soon" afterwards.
            dueSoonNotifiedAt: task.dueSoonNotifiedAt ?? now,
          })
          .where(eq(tasksTable.id, task.id));
        logger.info({ taskId: task.id }, "task overdue reminder sent");
      } else if (dueDate >= today && !task.dueSoonNotifiedAt) {
        await notifyUser({
          userId: assigneeId,
          dealerId: task.dealerId,
          type: "task",
          title: `Task due ${dueDate === today ? "today" : "tomorrow"}: ${task.title}`,
          body: `This ${task.priority}-priority task is due ${dueDate}. Wrap it up or update its due date.`,
          link: "/tasks",
        });
        await db
          .update(tasksTable)
          .set({ dueSoonNotifiedAt: now })
          .where(eq(tasksTable.id, task.id));
        logger.info({ taskId: task.id }, "task due-soon reminder sent");
      }
    } catch (err) {
      logger.error({ err, taskId: task.id }, "task reminder failed");
    }
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

export function startEmailWorker(): void {
  if (process.env.OUTBOX_WORKER_DISABLED === "1") {
    logger.info("email queue worker disabled");
    return;
  }
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void processQueue();
    void processTaskReminders();
  }, 20_000);
  setTimeout(() => void processTaskReminders(), 3_000);
  logger.info("email queue worker started");
}

// ---------------------------------------------------------------------------
// Notifications helper — other modules call this
// ---------------------------------------------------------------------------

export type NotifyUserOptions = {
  userId: number;
  dealerId: number;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  /**
   * R6.3 natural-key dedupe scope. When both are set, a repeat notification
   * for the same (dealer, user, type, entity) UPSERTS the existing row —
   * refreshing title/body, marking it unread and bumping updatedAt — instead
   * of stacking duplicates in the bell.
   */
  entityType?: string;
  entityId?: number;
};

export async function notifyUser(opts: NotifyUserOptions): Promise<void> {
  const values = {
    userId: opts.userId,
    dealerId: opts.dealerId,
    type: opts.type,
    title: opts.title,
    body: opts.body ?? null,
    link: opts.link ?? null,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId ?? null,
  };
  if (opts.entityType && opts.entityId != null) {
    await db
      .insert(notificationsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          notificationsTable.dealerId,
          notificationsTable.userId,
          notificationsTable.type,
          notificationsTable.entityType,
          notificationsTable.entityId,
        ],
        targetWhere: sql`entity_type is not null and entity_id is not null`,
        set: {
          title: opts.title,
          body: opts.body ?? null,
          link: opts.link ?? null,
          read: false,
          updatedAt: new Date(),
        },
      });
    return;
  }
  await db.insert(notificationsTable).values(values);
}

export async function notifyUsers(
  userIds: number[],
  opts: Omit<NotifyUserOptions, "userId">,
): Promise<void> {
  for (const userId of userIds) {
    await notifyUser({ ...opts, userId });
  }
}
