import { logger } from "./logger";

// ---------------------------------------------------------------------------
// PENDING-INFRA seams. These are the wait-for-infrastructure items from the
// enterprise-hardening plan. Each is an interface with a no-op default so
// application code can already call the seam; wiring a real provider is a
// drop-in replacement once the client provisions the infrastructure.
//
// NONE of these perform real work today — by design.
// ---------------------------------------------------------------------------

/** TODO(PENDING-INFRA): disaster recovery / backups — wire to managed Postgres PITR + object-storage backup jobs when provisioned. */
export interface BackupProvider {
  scheduleBackups(): void;
  lastBackupAt(): Date | null;
}
export const backupProvider: BackupProvider = {
  scheduleBackups() {
    logger.warn("PENDING-INFRA: backups/DR not provisioned — no backup schedule active");
  },
  lastBackupAt: () => null,
};

/** TODO(PENDING-INFRA): encryption at rest — provided by the managed database tier; nothing to do in-app beyond confirming the provider setting. */
export interface EncryptionAtRestStatus {
  provider: string | null;
  enabled: boolean;
}
export function encryptionAtRestStatus(): EncryptionAtRestStatus {
  return { provider: null, enabled: false };
}

/** TODO(PENDING-INFRA): uptime SLA monitoring — point an external uptime checker at GET /api/healthz and wire alerting here. */
export interface UptimeMonitor {
  heartbeat(): void;
}
export const uptimeMonitor: UptimeMonitor = {
  heartbeat() {
    /* no-op until an external monitor + alert channel exist */
  },
};

/** TODO(PENDING-INFRA): managed distributed tracing — replace with an OTLP exporter (OpenTelemetry) once a collector endpoint exists. */
export interface TraceExporter {
  exportSpan(name: string, attributes: Record<string, unknown>): void;
}
export const traceExporter: TraceExporter = {
  exportSpan() {
    /* spans are dropped until a collector is provisioned */
  },
};

/** TODO(PENDING-INFRA): message broker — replace direct in-process hooks (email queue tick, agent triggers) with a durable broker (SQS/RabbitMQ/Kafka) when provisioned. */
export interface MessageBroker {
  publish(topic: string, payload: unknown): Promise<void>;
}
export const messageBroker: MessageBroker = {
  async publish(topic) {
    logger.debug({ topic }, "PENDING-INFRA: message broker not provisioned — event handled in-process");
  },
};

/** Logged once at boot so the pending seams are visible in operations. */
export function logPendingInfraSeams(): void {
  logger.info(
    {
      pendingInfra: [
        "disaster-recovery/backups",
        "encryption-at-rest (managed DB)",
        "uptime SLA monitoring",
        "managed tracing (OTLP)",
        "message broker",
      ],
    },
    "PENDING-INFRA seams scaffolded (no-op until infrastructure is provisioned)",
  );
}
