# AURA Dealership OS — GCP Enterprise Architecture (DEV + PROD)

Scope: React web apps (AURA + Realm), Node/Express API, AI agents (sessions, feedback,
conversation history, document-extracted data), PostgreSQL OLTP, deployed on autoscaled VMs.
Traffic profile: Guyana-only users, ~1,000 transactions/day (low volume — size small, scale on demand).

---

## 1. Region & Project layout

| Item | Choice | Why |
|---|---|---|
| Primary region | `southamerica-east1` (São Paulo) | Closest GCP region to Guyana (~40–60 ms). |
| DR / backups region | `us-east1` | Cross-region backup target. |
| Projects | `aura-dev`, `aura-prod` (+ optional `aura-shared` for CI/CD & artifacts) | Hard blast-radius isolation; separate billing, IAM, quotas. |
| Org policy | Folder `AURA` with org policies applied at folder level | Enforce guardrails once (no public IPs, domain-restricted sharing, uniform bucket access). |

## 2. Compute (VMs, autoscaled)

- **Managed Instance Group (MIG)** of Compute Engine VMs running the Node API (containerized
  with Docker via container-optimized OS, or a hardened Debian image + systemd).
  - PROD: `e2-standard-2`, min 2 / max 6, autoscale on CPU 60% + LB serving capacity, multi-zone
    (southamerica-east1-b/c) for zonal-failure tolerance.
  - DEV: `e2-small`, min 1 / max 2, single zone, can be scheduled off outside working hours.
- **No public IPs on any VM.** Egress via **Cloud NAT**; admin access via **IAP TCP tunneling**
  (no SSH ports open, no bastion needed).
- Frontends (AURA/Realm static builds) served from **Cloud Storage + Cloud CDN** behind the same
  load balancer (cheaper and safer than serving static from VMs).
- **Shielded VMs** (secure boot, vTPM, integrity monitoring) + OS Login with 2FA.
- Rolling updates via MIG instance templates (blue/green: new template, `maxSurge=1, maxUnavailable=0`).

## 3. Edge: LB, API Gateway, WAF

```
Users (Guyana)
   │ HTTPS (TLS 1.2+, managed certs)
   ▼
Global External HTTPS Load Balancer  ←── Cloud Armor (WAF)
   ├── /            → backend bucket (AURA SPA, Cloud CDN)
   ├── /realm/*     → backend bucket (Realm SPA, Cloud CDN)
   └── /api/*       → API Gateway → serverless NEG / MIG backend (Node API)
```

- **Cloud Armor** policies (PROD, enforce; DEV, preview mode):
  - Preconfigured OWASP rules: SQLi, XSS, LFI/RFI, RCE, protocol attacks.
  - **Geo-allowlist: `origin.region_code == 'GY'`** (allow GY; optionally allow your office/VPN
    country codes), default-deny the rest. This alone removes ~99% of attack surface.
  - Rate limiting: e.g. 60 req/min per IP with ban on abuse; stricter (10/min) on `/api/auth/*`
    and agent endpoints (LLM cost abuse protection).
  - Bot management / reCAPTCHA Enterprise challenge on login and public forms.
- **API Gateway** in front of the API backend: OpenAPI-driven routing, JWT validation (Google
  identities), per-consumer API keys/quotas for any machine-to-machine callers (e.g. bank
  connector callbacks), request/response validation. Your repo already generates OpenAPI —
  reuse that spec as the gateway contract.
- Managed SSL certs, HTTP→HTTPS redirect, HSTS.

## 4. Data layer

| Need | Service | Notes |
|---|---|---|
| OLTP (deals, invoices, parts, RBAC…) | **Cloud SQL for PostgreSQL** | PROD: HA (regional, automatic failover), `db-custom-2-8192`, PITR + daily backups (30-day retention, cross-region copies), deletion protection, CMEK. DEV: single-zone `db-f1/g1-small`, 7-day backups. **Private IP only** + Private Service Connect; app connects via Cloud SQL Auth connector with **IAM database authentication**. |
| Agent NoSQL (sessions, feedback, conversation history, extracted document data) | **Firestore (Native mode)** | Serverless, zero-ops, fits document-shaped agent data; per-collection TTL policies (e.g. auto-expire raw sessions after 90 days); daily managed backups; security rules deny all client access — **server-only access via service account** (agents run server-side). Separate databases per env (`(default)` in each project). |
| Cache / rate-limit / queues | **Memorystore for Redis** | PROD: 1 GB Standard (HA); DEV: 1 GB Basic. Sessions cache, idempotency claims, WhatsApp outbound queue, hot lookups. AUTH enabled + in-transit TLS. |
| Documents / uploads | **Cloud Storage** | Buckets per env; uniform bucket-level access; signed URLs only (your storage-ACL fail-closed pattern carries over); CMEK; object versioning on PROD. |
| Analytics (optional later) | BigQuery | Nightly Cloud SQL federated export for reporting; not needed day 1. |

At 1,000 TPM/day these are the smallest sensible tiers — the design scales 100× by resizing, not re-architecting.

## 5. Identity & access

- **Google SSO (staff login):** Identity Platform / Google Identity with **OIDC**, restricted to
  your Workspace domain (`hd` claim check server-side). If you keep Clerk, configure Clerk's
  Google connection instead — but for "enterprise GCP" the native option is Identity Platform
  with the Google provider + your existing RBAC (roles/permissions stay in Postgres exactly as today).
- **IAP (Identity-Aware Proxy)** in front of the **Realm super-admin app** in PROD — a second,
  Google-enforced auth wall limited to a small admin group, independent of app code.
- **Workforce IAM:** groups not users (`gcp-aura-admins`, `gcp-aura-devs`, `gcp-aura-viewers`);
  devs have zero standing access to PROD (break-glass via short-lived privileged access / PAM).
- **Workload identity:** one service account per component (api-vm, agents, ci-deployer) with
  least privilege; no SA keys ever — attached SAs + Workload Identity Federation for GitHub Actions CI/CD.

## 6. Secrets

- **Secret Manager** for everything currently in Replit secrets (Clerk/Twilio/Gmail/LLM keys,
  session secret, DB users): per-env secrets, CMEK, automatic replication to the primary region,
  **rotation schedules** (90 days), access only by the specific runtime SA, audit logging on access.
- App reads secrets at boot via the Secret Manager client (or `berglas`/systemd env injection) —
  never baked into images, never in instance metadata.

## 7. Observability

- **Cloud Logging**: structured JSON logs from the API (request id, dealer id, user id — no PII
  payloads); 30-day default + export sink to a locked GCS bucket (400-day compliance retention).
- **Cloud Monitoring** dashboards: LB 5xx & latency (p50/p95/p99), MIG CPU/instance count,
  Cloud SQL connections/replication/disk, Redis hit rate, Firestore ops, LLM token spend (custom metric).
- **Alerting** (PagerDuty/e-mail/Slack): uptime check on `/api/health` from 3 regions, 5xx ratio > 2%,
  p95 latency > 1.5 s, SQL storage > 80%, failed-login spike, Cloud Armor deny spike, budget alerts.
- **Cloud Trace** (OpenTelemetry SDK in Express) + **Error Reporting** for stack-trace grouping.
- **Audit**: Admin Activity logs on (default); enable **Data Access logs** for Cloud SQL,
  Firestore, Secret Manager in PROD.

## 8. Security hardening (defense in depth)

1. **Network:** custom VPC per project; private subnets only; firewall default-deny ingress;
   only LB health-check + Google frontend ranges reach the MIG; VPC Service Controls perimeter
   around SQL/Firestore/Storage/Secret Manager in PROD (blocks data exfiltration even with stolen creds).
2. **Edge:** Cloud Armor geo-fence (GY) + OWASP + rate limits + reCAPTCHA (above).
3. **App:** keep your existing controls (RBAC explicit-view, tenancy stamping, idempotency,
   fail-closed storage ACLs) — infra complements, never replaces them. Add helmet/CSP headers,
   strict CORS to your exact domains.
4. **Agent-specific:** agents run server-side only; LLM keys only in Secret Manager; per-dealer
   agent kill switches (already built) + Cloud Armor rate caps on agent endpoints; prompt-injection
   containment: agents get scoped DB access via the API layer (RBAC-checked), never raw SQL;
   Firestore rules deny all client SDK access; log every agent run (you have the agent_runs ledger).
5. **Supply chain:** Artifact Registry with vulnerability scanning; Binary Authorization (PROD
   only runs signed images from your CI); Dependabot/`pnpm audit` in CI; Container Analysis.
6. **Posture:** Security Command Center Standard (free tier) — misconfig & public-exposure findings;
   Web Security Scanner against DEV weekly.
7. **Data:** CMEK on SQL/Firestore/GCS/secrets; TLS everywhere in transit; DLP scan on
   document-extraction buckets if IDs/financial docs are stored.
8. **DDoS:** absorbed by Google global LB + Cloud Armor (standard tier is enough at this scale).

## 9. DEV vs PROD summary

| Dimension | DEV (`aura-dev`) | PROD (`aura-prod`) |
|---|---|---|
| VMs | e2-small ×1–2, single zone, auto-shutdown nights | e2-standard-2 ×2–6, multi-zone MIG, Shielded |
| Cloud SQL | single-zone small, 7-day backup | Regional HA, PITR, 30-day + cross-region backups, CMEK |
| Firestore | own DB, relaxed TTLs | TTL + daily backups, VPC-SC perimeter |
| Redis | Basic 1 GB | Standard (HA) 1 GB, AUTH + TLS |
| Cloud Armor | preview (log-only) mode | enforced: geo GY, OWASP, rate limits |
| IAP on Realm | optional | required |
| Access | devs deploy freely via CI | CI-only deploys, no human standing access, Binary Auth |
| Domains | `dev.yourdomain.gy` | `app.yourdomain.gy` (+ `realm.` subdomain) |
| Est. monthly cost | ~US$150–250 | ~US$600–900 |

## 10. CI/CD & IaC

- **Terraform** for all of the above (google provider), state in a GCS backend, one workspace per env;
  changes to PROD only via reviewed PRs (you now have GitHub connected).
- **GitHub Actions → Workload Identity Federation** (no SA keys): build → test/typecheck →
  build image → push Artifact Registry → deploy DEV MIG → manual approval gate → PROD rolling update.
- Cloud SQL schema changes via your existing Drizzle migrations, run as a CI step against the
  private instance through the Cloud SQL connector (remember the additive NOT-NULL pre-migration rule).

## 11. Migration order (practical)

1. Terraform the DEV project end-to-end; deploy the API container to the DEV MIG.
2. Point the app at Cloud SQL (pg_dump/restore from current DB) and Firestore (write agent
   persistence adapter — sessions/conversations/extractions move out of Postgres if any live there).
3. Wire Secret Manager + Google SSO in DEV; run your regression suites against DEV.
4. Clone to PROD via the same Terraform with prod tfvars; enforce Cloud Armor; cut DNS over.
