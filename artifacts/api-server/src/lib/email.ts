import nodemailer from "nodemailer";
import { and, eq, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import {
  db,
  emailLogsTable,
  notificationsTable,
  tasksTable,
  timelineEventsTable,
  EMAIL_TEMPLATES,
  type EmailTemplate,
  type EmailLog,
} from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

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
  cta?: (d: TemplateData) => { label: string; note?: string };
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
      `Thank you for your interest in the <strong>${d(x, "vehicle", "vehicle of your choice")}</strong>. Your personal concierge has been assigned and will reach out shortly with availability, pricing and a tailored walk-through.`,
    cta: () => ({ label: "Your concierge is on it" }),
    sample: { name: "Alex Mensah", vehicle: "2026 Aston Martin DB12" },
  },
  test_drive_confirmation: {
    label: "Test Drive Confirmation",
    description: "Confirms a scheduled test drive appointment.",
    subject: (x) => `Your test drive is confirmed — ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Your test drive is confirmed",
    body: (x) =>
      `We look forward to hosting you on <strong>${d(x, "date", "your scheduled date")}</strong> at ${d(x, "time", "the agreed time")}. The <strong>${d(x, "vehicle", "vehicle")}</strong> will be detailed, charged/fuelled and waiting at the showroom entrance.`,
    cta: () => ({ label: "Showroom concierge will greet you" }),
    sample: { vehicle: "2026 BMW i7", date: "Friday, July 18", time: "10:30 AM" },
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
  delivery_confirmation: {
    label: "Delivery Confirmation",
    description: "Celebrates the completed handover.",
    subject: () => "Welcome to the family — delivery complete",
    heading: (x) => `The keys are yours, ${d(x, "name", "and it suits you")}`,
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "new vehicle")}</strong> has been delivered. Every AURA vehicle includes our concierge aftercare — service bookings, warranty and support are one message away.`,
    sample: { name: "Alex", vehicle: "2026 Bentley Continental GT" },
  },
  service_reminder: {
    label: "Service Reminder",
    description: "Reminds the customer of upcoming service.",
    subject: (x) => `Service due — ${d(x, "vehicle", "your vehicle")}`,
    heading: () => "Time for a little care",
    body: (x) =>
      `Your <strong>${d(x, "vehicle", "vehicle")}</strong> is due for <strong>${d(x, "service", "scheduled maintenance")}</strong>${x.date ? ` around <strong>${x.date}</strong>` : ""}. Reply to this email or call your concierge and we'll arrange pickup.`,
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
  smtp_test: {
    label: "SMTP Test",
    description: "Verifies the Gmail SMTP configuration.",
    subject: () => "AURA email engine — test successful",
    heading: () => "Your email engine is live",
    body: () =>
      `This is a test message from the AURA Dealership OS email engine. If you're reading this, your Gmail SMTP configuration is working perfectly.`,
    sample: {},
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
            <div style="display:inline-block;background-color:#e01313;color:#ffffff;font-size:13px;font-weight:600;letter-spacing:0.5px;padding:12px 26px;border-radius:999px;">${cta.label}</div>
          </td></tr>`
            : ""
        }
        <tr>
          <td style="padding:36px 44px 32px;">
            <div style="border-top:1px solid #262626;padding-top:20px;font-size:11px;color:#6f6f6f;line-height:1.6;">
              AURA Dealership — Premium Automotive Concierge<br/>
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
// Queue — DB-backed with retry
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

export type EnqueueOptions = {
  template: EmailTemplate;
  to: string;
  customerId?: number | null;
  data?: TemplateData;
};

/**
 * Typed event API for other modules: enqueue a templated email.
 * The queue worker delivers it, retries on failure, and logs everything.
 */
export async function enqueueEmail(opts: EnqueueOptions): Promise<EmailLog> {
  const { subject } = renderEmail(opts.template, opts.data ?? {});
  const [row] = await db
    .insert(emailLogsTable)
    .values({
      customerId: opts.customerId ?? null,
      recipient: opts.to,
      subject,
      template: opts.template,
      channel: "email",
      status: "queued",
      payload: opts.data ?? {},
    })
    .returning();
  // Kick the worker soon so sends feel immediate.
  setTimeout(() => void processQueue(), 50);
  return row!;
}

export function isKnownTemplate(key: string): key is EmailTemplate {
  return (EMAIL_TEMPLATES as readonly string[]).includes(key);
}

let processing = false;

export async function processQueue(): Promise<void> {
  if (processing || !smtpConfigured()) return;
  processing = true;
  try {
    const pending = await db
      .select()
      .from(emailLogsTable)
      .where(
        and(
          or(
            eq(emailLogsTable.status, "queued"),
            and(
              eq(emailLogsTable.status, "failed"),
              lt(emailLogsTable.attempts, MAX_ATTEMPTS),
            ),
          ),
          eq(emailLogsTable.channel, "email"),
        ),
      )
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
        await transport.sendMail({
          from: `"AURA Dealership" <${process.env.GMAIL_USER}>`,
          to: item.recipient,
          subject,
          html,
        });
        await db
          .update(emailLogsTable)
          .set({ status: "sent", sentAt: new Date(), lastError: null })
          .where(eq(emailLogsTable.id, item.id));
        if (item.customerId) {
          await db.insert(timelineEventsTable).values({
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
        await db
          .update(emailLogsTable)
          .set({ status: "failed", lastError: message })
          .where(eq(emailLogsTable.id, item.id));
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

export async function notifyUser(opts: {
  userId: number;
  type: "approval" | "assignment" | "task" | "email" | "system";
  title: string;
  body?: string;
  link?: string;
}): Promise<void> {
  await db.insert(notificationsTable).values({
    userId: opts.userId,
    type: opts.type,
    title: opts.title,
    body: opts.body ?? null,
    link: opts.link ?? null,
  });
}

export async function notifyUsers(
  userIds: number[],
  opts: Omit<Parameters<typeof notifyUser>[0], "userId">,
): Promise<void> {
  if (userIds.length === 0) return;
  await db.insert(notificationsTable).values(
    userIds.map((userId) => ({
      userId,
      type: opts.type,
      title: opts.title,
      body: opts.body ?? null,
      link: opts.link ?? null,
    })),
  );
}
