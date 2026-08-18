// ---------------------------------------------------------------------------
// Minimal server-side client for ERPNext's DocType REST API (token auth).
// https://frappeframework.com/docs/user/en/api/rest
// Structured errors + hard timeouts so an unreachable ERPNext can never
// stall AURA request handling or the sync worker.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

export class ErpnextError extends Error {
  /** HTTP status from ERPNext, or 0 for network/timeout failures. */
  readonly status: number;
  /** Machine-friendly kind for retry decisions. */
  readonly kind: "network" | "timeout" | "auth" | "not_found" | "http";

  constructor(message: string, status: number, kind: ErpnextError["kind"]) {
    super(message);
    this.name = "ErpnextError";
    this.status = status;
    this.kind = kind;
  }

  /** Auth and not-found failures won't fix themselves by retrying. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "timeout" || this.status >= 500 || this.status === 429;
  }
}

export type ErpnextClientConfig = {
  siteUrl: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs?: number;
};

function normalizeSiteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export class ErpnextClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(cfg: ErpnextClientConfig) {
    this.base = normalizeSiteUrl(cfg.siteUrl);
    this.authHeader = `token ${cfg.apiKey}:${cfg.apiSecret}`;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    // SSRF policy: re-checked before EVERY fetch (not just at save time) so
    // a DNS rebind after saving can't route the token to an internal host.
    const { assertSafeErpnextUrl, ErpnextUrlPolicyError } = await import(
      "./url-policy"
    );
    try {
      await assertSafeErpnextUrl(this.base);
    } catch (err) {
      if (err instanceof ErpnextUrlPolicyError) {
        throw new ErpnextError(err.message, 0, "auth"); // non-retryable
      }
      throw err;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        // Never follow redirects: a compliant ERPNext API answers directly,
        // and a redirect could re-route the Authorization header elsewhere.
        redirect: "error",
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      throw new ErpnextError(
        timedOut
          ? `ERPNext did not respond within ${this.timeoutMs / 1000}s`
          : `Could not reach ERPNext at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
        0,
        timedOut ? "timeout" : "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      let detail = "";
      try {
        const text = await resp.text();
        // Frappe errors carry `exc_type` / `_server_messages`; keep it short.
        try {
          const parsed = JSON.parse(text) as {
            exc_type?: string;
            exception?: string;
            message?: string;
          };
          detail =
            parsed.exception ?? parsed.exc_type ?? parsed.message ?? text;
        } catch {
          detail = text;
        }
      } catch {
        /* body unreadable */
      }
      const kind =
        resp.status === 401 || resp.status === 403
          ? "auth"
          : resp.status === 404
            ? "not_found"
            : "http";
      throw new ErpnextError(
        `ERPNext ${resp.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        resp.status,
        kind,
      );
    }
    try {
      return (await resp.json()) as T;
    } catch {
      throw new ErpnextError(
        `The server at ${this.base} did not return JSON — check that the site URL points at an ERPNext instance`,
        resp.status,
        "http",
      );
    }
  }

  /** GET /api/resource/:doctype/:name */
  async getDoc<T = Record<string, unknown>>(doctype: string, name: string): Promise<T> {
    const { data } = await this.request<{ data: T }>(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    );
    return data;
  }

  /** GET /api/resource/:doctype with filters/fields/limit. */
  async listDocs<T = Record<string, unknown>>(
    doctype: string,
    opts: {
      filters?: unknown[][];
      fields?: string[];
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<T[]> {
    const params = new URLSearchParams();
    if (opts.filters) params.set("filters", JSON.stringify(opts.filters));
    if (opts.fields) params.set("fields", JSON.stringify(opts.fields));
    params.set("limit_page_length", String(opts.limit ?? 20));
    if (opts.offset) params.set("limit_start", String(opts.offset));
    const { data } = await this.request<{ data: T[] }>(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`,
    );
    return data;
  }

  /** POST /api/resource/:doctype — returns the created doc (incl. `name`). */
  async insertDoc<T = Record<string, unknown>>(
    doctype: string,
    doc: Record<string, unknown>,
  ): Promise<T & { name: string }> {
    const { data } = await this.request<{ data: T & { name: string } }>(
      "POST",
      `/api/resource/${encodeURIComponent(doctype)}`,
      doc,
    );
    return data;
  }

  /** PUT /api/resource/:doctype/:name */
  async updateDoc<T = Record<string, unknown>>(
    doctype: string,
    name: string,
    doc: Record<string, unknown>,
  ): Promise<T> {
    const { data } = await this.request<{ data: T }>(
      "PUT",
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      doc,
    );
    return data;
  }

  /** Submit a saved doc (docstatus 0 → 1) via frappe.client.submit. */
  async submitDoc(doctype: string, name: string): Promise<void> {
    const doc = await this.getDoc(doctype, name);
    await this.request("POST", "/api/method/frappe.client.submit", {
      doc: { ...doc, doctype },
    });
  }

  /** Cancel a submitted doc (docstatus 1 → 2). Fetches the document first
   * (mirrors submitDoc) so we fail fast with a clear "not found" and can
   * short-circuit docs that are already cancelled; the cancel call itself
   * carries both the frappe.client.cancel signature args (doctype, name)
   * and the full doc for API variants that expect it. */
  async cancelDoc(doctype: string, name: string): Promise<void> {
    const doc = await this.getDoc<{ docstatus?: number }>(doctype, name);
    if (doc.docstatus === 2) return; // already cancelled — idempotent
    await this.request("POST", "/api/method/frappe.client.cancel", {
      doctype,
      name,
      doc: { ...doc, doctype },
    });
  }

  /** Verify credentials and report the connected user, version and default
   * company — used by the settings "Test connection" button. */
  async testConnection(): Promise<{
    user: string;
    version: string | null;
    companyName: string | null;
    companyNames: string[];
  }> {
    const { message: user } = await this.request<{ message: string }>(
      "GET",
      "/api/method/frappe.auth.get_logged_user",
    );
    let version: string | null = null;
    try {
      const v = await this.request<{ message?: Record<string, string> }>(
        "GET",
        "/api/method/version",
      );
      version = typeof v.message === "string" ? v.message : null;
    } catch {
      /* optional */
    }
    let companyName: string | null = null;
    let companyNames: string[] = [];
    try {
      const companies = await this.listDocs<{ name: string }>("Company", {
        limit: 20,
      });
      companyNames = companies.map((c) => c.name);
      companyName = companyNames[0] ?? null;
    } catch {
      /* Accounts module may not be enabled yet */
    }
    return { user, version, companyName, companyNames };
  }
}
