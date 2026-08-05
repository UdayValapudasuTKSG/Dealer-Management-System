import nodemailer from "nodemailer";
import { and, eq, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import {
  db,
  emailLogsTable,
  notificationsTable,
  receiptsTable,
  tasksTable,
  timelineEventsTable,
  whatsappConversationsTable,
  EMAIL_TEMPLATES,
  type EmailTemplate,
  type EmailLog,
  type WhatsappKind,
  type NotificationType,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { buildQuotePdf } from "./quote-pdf";
import { buildInvoicePdfFromPayload, buildReceiptPdf } from "./document-pdfs";
import { getDealerPdfBranding } from "./dealer-branding";
import { testDriveIcsFromPayload } from "./calendar";
import {
  whatsappConfig,
  whatsappProvider,
  sendWhatsappText,
  twilioWhatsappConfig,
  sendTwilioWhatsappText,
} from "./whatsapp";
import { recordWhatsappMessage } from "./whatsapp-log";

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

export function smtpConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export function fromAddress(): string | null {
  return process.env.GMAIL_USER ?? null;
}

function makeTransport() {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    // Pooled connections: reuse one authenticated session for many messages
    // instead of a fresh SMTP login per email. A mass enqueue once tripped
    // Gmail's "454 too many login attempts" throttle because every send
    // opened its own connection — pooling keeps logins rare and throttles
    // the send rate to stay inside Gmail's limits.
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    rateDelta: 1000,
    rateLimit: 1,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

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
  lead_received: {
    label: "Lead Received",
    description: "Warm welcome the moment an enquiry lands.",
    subject: (x) => `We received your enquiry, ${d(x, "name", "there")}`,
    heading: (x) => `Welcome to AURA, ${d(x, "name", "there")}`,
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
      `Thank you for your interest in the <strong>${d(x, "vehicle", "vehicle of your choice")}</strong>. Your personalised quotation is attached as a PDF — it covers the ${d(x, "color", "selected")} finish at <strong>${d(x, "total", "the current showroom price")}</strong> and is valid until <strong>${d(x, "validUntil", "the date shown on the quote")}</strong>. ${
        x.link
          ? "Ready to take the wheel? Reserve your test-drive slot below — it takes under a minute."
          : "Your sales advisor will follow up shortly to arrange a viewing or test drive."
      }`,
    cta: (x) =>
      x.link
        ? { label: "Book your test drive", href: x.link }
        : { label: "Your quotation is attached" },
    sample: {
      name: "Alex Mensah",
      vehicle: "2026 BMW i7 xDrive60",
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
      (x.advisorPhone
        ? `To arrange a time that suits you, call your sales advisor <strong>${d(x, "advisorName", "our team")}</strong> on <strong>${x.advisorPhone}</strong> — the vehicle will be detailed, charged/fuelled and waiting at the showroom entrance.`
        : `Your sales advisor${x.advisorName ? ` <strong>${x.advisorName}</strong>` : ""} will call you shortly to arrange a time — the vehicle will be detailed, charged/fuelled and waiting at the showroom entrance.`),
    cta: (x) =>
      x.advisorPhone
        ? {
            label: `Call ${d(x, "advisorName", "your sales advisor")} — ${x.advisorPhone}`,
            href: `tel:${x.advisorPhone.replace(/[^+\d]/g, "")}`,
          }
        : { label: "Your sales advisor will call you" },
    sample: {
      name: "Alex Mensah",
      vehicle: "2026 BMW i7 xDrive60",
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
      vehicle: "2026 BMW i7 xDrive60",
      date: "Friday, July 18",
      time: "10:30 AM",
      branch: "Main Showroom",
    },
  },
  lead_assignment: {
    label: "Lead Assignment",
    description: "Introduces the assigned advisor to the customer.",
    subject: (x) => `${d(x, "advisor", "Your advisor")} is your personal AURA advisor`,
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
    subject: () => "A gentle reminder from AURA",
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
      `Great news — the <strong>${d(x, "service", "requested work")}</strong> on your <strong>${d(x, "vehicle", "vehicle")}</strong> is complete. It has been washed, quality-checked and is waiting for you at the service reception. Collect it at your convenience, or reply and we'll arrange drop-off.`,
    cta: () => ({ label: "Ready when you are" }),
    sample: { vehicle: "2025 BMW X7", service: "20,000 km service" },
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
      `Your <strong>${d(x, "vehicle", "new vehicle")}</strong> has been delivered. Every AURA vehicle includes our sales advisor aftercare — service bookings, warranty and support are one message away.`,
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
    heading: () => "Your opinion shapes AURA",
    body: (x) =>
      `Thank you for choosing us${x.context ? ` for ${x.context}` : ""}. If you have two minutes, we'd love to hear how the experience felt — every note reaches the general manager directly.`,
    sample: { context: "your recent delivery" },
  },
  thank_you: {
    label: "Thank You",
    description: "A simple, elegant thank-you note.",
    subject: (x) => `Thank you, ${d(x, "name", "from all of us at AURA")}`,
    heading: () => "Thank you",
    body: (x) =>
      `${d(x, "message", "It has been a privilege to look after you. From everyone at AURA, thank you for your trust — we're here whenever you need us.")}`,
    sample: { name: "Alex", message: "It has been a privilege to look after you this month. From everyone at AURA — thank you." },
  },
  outreach: {
    label: "Personal Outreach",
    description: "A personal note from the advisor, drafted with AI and approved before sending.",
    subject: (x) => d(x, "subject", `A note from ${d(x, "advisor", "your AURA advisor")}`),
    heading: (x) => `Hello ${d(x, "name", "there")}`,
    body: (x) =>
      `${d(x, "message", "Your advisor has an update for you.").replace(/\n/g, "<br/>")}`,
    cta: (x) => ({ label: d(x, "advisor", "Your AURA advisor") }),
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
    subject: (x) => `Your AURA invoice ${d(x, "invoiceNumber", "")}`.trim(),
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
    subject: () => "Two minutes to shape your AURA experience",
    heading: (x) => `How did we do, ${d(x, "name", "")}?`.trim(),
    body: (x) =>
      `Thank you${x.context ? ` for ${x.context}` : ""}. We'd love two minutes of your time — your feedback goes straight to the general manager and shapes how we look after you next.`,
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
};

export function renderEmail(
  template: EmailTemplate,
  data: TemplateData,
): { subject: string; html: string } {
  const def = TEMPLATE_DEFS[template];
  const subject = def.subject(data);
  const heading = def.heading(data);
  const body = def.body(data);
  const cta = def.cta?.(data);
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#121212;border:1px solid #262626;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="height:4px;background:linear-gradient(90deg,#7a0d0d,#e01313,#7a0d0d);font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:36px 44px 8px;">
            <div style="font-size:22px;font-weight:700;letter-spacing:1px;color:#ffffff;">AURA<span style="color:#e01313;">.OS</span></div>
            <div style="font-size:10px;letter-spacing:3px;color:#8a8a8a;text-transform:uppercase;margin-top:4px;">Dealership Operating System</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 44px 0;">
            <div style="font-size:26px;font-weight:600;color:#ffffff;line-height:1.3;">${heading}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 44px 0;">
            <div style="font-size:15px;color:#c9c9c9;line-height:1.7;">${body}</div>
          </td>
        </tr>
        ${
          cta
            ? `<tr><td style="padding:28px 44px 0;">
            ${
              cta.href
                ? `<a href="${cta.href}" style="display:inline-block;background-color:#e01313;color:#ffffff;font-size:13px;font-weight:600;letter-spacing:0.5px;padding:12px 26px;border-radius:999px;text-decoration:none;">${cta.label}</a>`
                : `<div style="display:inline-block;background-color:#e01313;color:#ffffff;font-size:13px;font-weight:600;letter-spacing:0.5px;padding:12px 26px;border-radius:999px;">${cta.label}</div>`
            }
          </td></tr>`
            : ""
        }
        <tr>
          <td style="padding:36px 44px 32px;">
            <div style="border-top:1px solid #262626;padding-top:20px;font-size:11px;color:#6f6f6f;line-height:1.6;">
              AURA Dealership — Premium Automotive Sales Advisory<br/>
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
export async function enqueueEmail(opts: EnqueueOptions): Promise<EmailLog> {
  const { subject } = renderEmail(opts.template, opts.data ?? {});
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

/** R6.4: true when the phone has an explicit WhatsApp opt-out on record. */
export async function isWhatsappOptedOut(phone: string): Promise<boolean> {
  const digits = phone.replace(/\D/g, "");
  const [row] = await db
    .select({ optedOutAt: whatsappConversationsTable.optedOutAt })
    .from(whatsappConversationsTable)
    .where(eq(whatsappConversationsTable.phone, digits));
  return Boolean(row?.optedOutAt);
}

/**
 * Enqueue an outbound WhatsApp message through the same DB-backed outbox.
 * The worker sends it via the Meta transport, records the transcript, and
 * retries with backoff on failure — failures stay visible in the outbox log.
 */
export async function enqueueWhatsapp(
  opts: EnqueueWhatsappOptions,
): Promise<EmailLog> {
  const digits = opts.to.replace(/\D/g, "");

  // R6.4 opt-out enforcement at the enqueue boundary: a suppressed row is
  // still written (status "cancelled") so the outbox log shows WHY nothing
  // went out, then the cascade downgrades to Email (or In-App notice).
  if (await isWhatsappOptedOut(digits)) {
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
        status: "cancelled",
        lastError: "Recipient has opted out of WhatsApp (STOP)",
        payload: { body: opts.body },
        dedupeKey: opts.dedupeKey ?? null,
      })
      .onConflictDoNothing({ target: emailLogsTable.dedupeKey })
      .returning();
    if (opts.fallbackEmail) {
      await enqueueEmail({
        template: opts.fallbackEmail.template,
        to: opts.fallbackEmail.to,
        dealerId: opts.dealerId,
        customerId: opts.customerId ?? null,
        leadId: opts.leadId ?? null,
        data: opts.fallbackEmail.data,
        dedupeKey: opts.dedupeKey ? `${opts.dedupeKey}:optOutEmail` : undefined,
        notifyUserId: opts.notifyUserId,
      });
    } else if (opts.notifyUserId != null) {
      await notifyUser({
        dealerId: opts.dealerId,
        userId: opts.notifyUserId,
        type: "channel.delivery.failed",
        title: "WhatsApp suppressed — customer opted out",
        body: `${opts.summary ?? opts.kind}: recipient ${digits} has opted out of WhatsApp and no email is on file. Reach out manually.`,
        entityType: row ? "email_log" : undefined,
        entityId: row?.id,
      });
    }
    if (row) return row;
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
      recipient: digits,
      subject: opts.summary ?? opts.body.slice(0, 140),
      template: opts.kind,
      channel: "whatsapp",
      status: "queued",
      payload: {
        body: opts.body,
        ...(opts.actor ? { actor: opts.actor } : {}),
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
  setTimeout(() => void processQueue(), 50);
  return row;
}

export function isKnownTemplate(key: string): key is EmailTemplate {
  return (EMAIL_TEMPLATES as readonly string[]).includes(key);
}

let processing = false;

/** Items ready for a (re)try: queued or retryable-failed, past their backoff time. */
function readyFilter(channel: "email" | "whatsapp") {
  return and(
    or(
      eq(emailLogsTable.status, "queued"),
      and(
        eq(emailLogsTable.status, "failed"),
        lt(emailLogsTable.attempts, MAX_ATTEMPTS),
      ),
    ),
    eq(emailLogsTable.channel, channel),
    or(
      isNull(emailLogsTable.nextAttemptAt),
      lte(emailLogsTable.nextAttemptAt, new Date()),
    ),
  );
}

/** Mark an item failed and schedule its next retry with exponential backoff. */
async function markFailed(item: EmailLog, attempts: number, message: string) {
  const terminal = attempts >= MAX_ATTEMPTS;
  await db
    .update(emailLogsTable)
    .set({
      status: "failed",
      lastError: message,
      nextAttemptAt: terminal ? null : backoffDate(attempts),
    })
    .where(eq(emailLogsTable.id, item.id));
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

async function processWhatsappQueue(): Promise<void> {
  const pending = await db
    .select()
    .from(emailLogsTable)
    .where(readyFilter("whatsapp"))
    .limit(10);
  if (pending.length === 0) return;

  const metaCfg = whatsappConfig();
  const twilioCfg = twilioWhatsappConfig();
  // Explicit WHATSAPP_PROVIDER wins; fall back to whichever is configured.
  const preferTwilio = whatsappProvider() === "twilio" && twilioCfg !== null;
  for (const item of pending) {
    const attempts = item.attempts + 1;
    await db
      .update(emailLogsTable)
      .set({ status: "sending", attempts })
      .where(eq(emailLogsTable.id, item.id));
    if (!metaCfg && !twilioCfg) {
      await markFailed(
        item,
        attempts,
        "WhatsApp sending is not configured (no Meta Cloud API or Twilio WhatsApp credentials).",
      );
      continue;
    }
    try {
      const body = item.payload?.body ?? "";
      if (!preferTwilio && metaCfg) {
        await sendWhatsappText(metaCfg, item.recipient, body);
      } else if (twilioCfg) {
        await sendTwilioWhatsappText(twilioCfg, item.recipient, body);
      }
      await db
        .update(emailLogsTable)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(emailLogsTable.id, item.id));
      await recordWhatsappMessage({
        phone: item.recipient,
        direction: "out",
        body,
        dealerId: item.dealerId,
        leadId: item.leadId,
        actor: item.payload?.["actor"] ?? "AURA Outbox",
      });
      logger.info({ id: item.id, kind: item.template }, "whatsapp sent");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(item, attempts, message);
      logger.error({ err, id: item.id }, "whatsapp send failed");
    }
  }
}

export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    await processWhatsappQueue();
  } catch (err) {
    logger.error({ err }, "whatsapp outbox pass failed");
  }
  try {
    if (!smtpConfigured()) return;
    const pending = await db
      .select()
      .from(emailLogsTable)
      .where(readyFilter("email"))
      .limit(10);
    if (pending.length === 0) return;

    const transport = makeTransport();
    for (const item of pending) {
      await db
        .update(emailLogsTable)
        .set({ status: "sending", attempts: item.attempts + 1 })
        .where(eq(emailLogsTable.id, item.id));
      try {
        const { subject, html } = renderEmail(
          item.template as EmailTemplate,
          item.payload ?? {},
        );
        let attachments:
          | { filename: string; content: Buffer; contentType: string }[]
          | undefined;
        if (item.template === "invoice.generated") {
          const pdf = await buildInvoicePdfFromPayload(
            item.payload ?? {},
            await getDealerPdfBranding(item.dealerId),
          );
          const ref = (item.payload?.invoiceNumber ?? `INV-${item.id}`).replace(
            /[^A-Za-z0-9-]/g,
            "",
          );
          attachments = [
            {
              filename: `AURA-Invoice-${ref}.pdf`,
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
              await getDealerPdfBranding(item.dealerId),
            );
            attachments = [
              {
                filename: `AURA-Receipt-${receipt.receiptNumber.replace(/[^A-Za-z0-9-]/g, "")}.pdf`,
                content: pdf,
                contentType: "application/pdf",
              },
            ];
          }
        }
        if (item.template === "vehicle_quote") {
          const pdf = await buildQuotePdf(
            item.payload ?? {},
            (await getDealerPdfBranding(item.dealerId)).logo,
          );
          const ref = (item.payload?.quoteRef ?? `Q-${item.id}`).replace(
            /[^A-Za-z0-9-]/g,
            "",
          );
          attachments = [
            {
              filename: `AURA-Quote-${ref}.pdf`,
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
          item.template === "test_drive_owner_invite"
        ) {
          try {
            const ics = testDriveIcsFromPayload(item.payload ?? {});
            if (ics) {
              icalEvent = {
                filename: "test-drive.ics",
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
        await transport.sendMail({
          from: `"AURA Dealership" <${process.env.GMAIL_USER}>`,
          to: item.recipient,
          subject,
          html,
          // Marks system-originated mail so the Gmail intake agent never
          // re-ingests our own outbound (quotes, reminders, tests) as leads.
          headers: { [SYSTEM_MAIL_HEADER]: "1" },
          ...(attachments ? { attachments } : {}),
          ...(icalEvent ? { icalEvent } : {}),
        });
        await db
          .update(emailLogsTable)
          .set({ status: "sent", sentAt: new Date(), lastError: null })
          .where(eq(emailLogsTable.id, item.id));
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
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(item, item.attempts + 1, message);
        logger.error({ err, id: item.id }, "email send failed");
      }
    }
  } finally {
    processing = false;
  }
}

// ---------------------------------------------------------------------------
// Task due-date reminders — due-soon (within 24h) and overdue, once each
// ---------------------------------------------------------------------------

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function processTaskReminders(): Promise<void> {
  const now = new Date();
  const today = localDateString(now);
  const tomorrow = localDateString(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  const candidates = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        ne(tasksTable.status, "done"),
        isNotNull(tasksTable.dueDate),
        isNotNull(tasksTable.assigneeUserId),
        lte(tasksTable.dueDate, tomorrow),
        or(
          isNull(tasksTable.dueSoonNotifiedAt),
          and(lt(tasksTable.dueDate, today), isNull(tasksTable.overdueNotifiedAt)),
        ),
      ),
    );

  for (const task of candidates) {
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
