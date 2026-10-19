import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dealerDayKey } from "@/lib/format";
import { customFetch } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";

export const BRANDS = ["BYD", "Foton", "Jetour", "BMW", "Accessories"] as const;
export type Brand = (typeof BRANDS)[number];

export type PosSource = { id: string; label: string; kind: "cash" | "bank"; account: string };
export type PosBrand = { brand: Brand; income: string; cogs: string; inventory: string; warehouse: string };
export type PosItem = { partId: number; itemCode: string };
export type PosConfig = {
  enabled: boolean;
  taxRate: number;
  taxApproved: boolean;
  approvalReference: string;
  receivable: string;
  vat: string;
  overShort: string;
  openingOffset: string;
  costCenter: string;
  sources: PosSource[];
  brands: PosBrand[];
  items: PosItem[];
};
export type PosLine = {
  partId: number; quantity: number; sku: string; name: string; brand: string;
  unitPrice: number; unitCost: number; net: number; tax: number;
  income: string; cogs: string; inventory: string; warehouse: string; itemCode: string;
};
export type PosSnapshot = {
  date: string; lines: PosLine[]; total: number; net: number; tax: number; cost: number;
  paid: number; balance: number; customerName: string;
  originalId?: number; expectedCash?: number; variance?: number;
  glLines?: GlLine[];
};
export type GlLine = { account: string; debit: number; credit: number; purpose: string };
export type Tender = { sourceId: string; amount: number };
export type PosInput =
  | { kind: "sale"; reference: string; customerId?: number; customerName?: string; lines: { partId: number; quantity: number }[]; tenders: Tender[] }
  | { kind: "return"; reference: string; originalId: number; goodsReceived: true; lines: { partId: number; quantity: number }[]; tenders: Tender[] }
  | { kind: "payment"; reference: string; originalId: number; tenders: Tender[] }
  | { kind: "shift_close"; reference: string; sourceId: string; destinationSourceId: string; businessDate: string; openingFloat: number; countedCash: number; transferAmount: number };
export type PosRequest = {
  id: number;
  kind: PosInput["kind"];
  status: string;
  input: PosInput;
  snapshot: PosSnapshot | null;
  createdBy: number;
  decidedBy: number | null;
  decisionNote: string | null;
  error: string | null;
  erpDocuments: { doctype: string; name: string }[];
  reconciliationReference: string | null;
  createdAt: string;
  availableBalance?: number;
  receivedBalance?: number;
  returnableLines?: { partId: number; quantity: number }[];
};
export type PosPart = { id: number; sku: string; name: string; barcode?: string | null; make?: string | null; unitPrice: number; unitCost?: number; quantityAvailable?: number; stock?: number };
export type PosCustomer = { id: number; name: string };
export type PosState = {
  config: PosConfig;
  revision: number;
  validation: { state: string; errors: string[] };
  requests: PosRequest[];
  parts: PosPart[];
  customers: PosCustomer[];
  canApprove: boolean;
  canEdit: boolean;
  userId: number;
  isDummy: boolean;
};

export type PosAction =
  | { action: "submit"; requestKey: string; input: PosInput }
  | { action: "approve" | "reject" | "retry" | "reconcile"; requestId: number; note: string }
  | { action: "save_config"; revision: number; config: PosConfig }
  | { action: "validate" }
  | { action: "seed" };

export function errorText(error: unknown) {
  const e = error as { data?: { error?: string; message?: string; errors?: string[] }; message?: string } | null;
  if (e?.data?.errors?.length) return e.data.errors.join("; ");
  return e?.data?.message ?? e?.data?.error ?? e?.message ?? "Request failed.";
}

export function usePosKey() {
  const { activeDealer } = useAuthz();
  return ["parts-pos", activeDealer?.dealerId] as const;
}

export function usePartsPos() {
  const key = usePosKey();
  return useQuery<PosState>({
    queryKey: key,
    queryFn: () => customFetch<PosState>("/api/parts-pos"),
    refetchInterval: 10_000,
  });
}

export function usePosAction() {
  const qc = useQueryClient();
  const key = usePosKey();
  return useMutation({
    mutationFn: (body: PosAction) =>
      customFetch<unknown>("/api/parts-pos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ predicate: (q) => /\/api\/parts|inventory/.test(String(q.queryKey[0] ?? "")) });
    },
  });
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const today = () => dealerDayKey();

/** Stable idempotency key per payload: retries of identical data reuse the key. */
export function useRequestKey() {
  const ref = useRef<{ fp: string; key: string } | null>(null);
  return {
    keyFor(payload: unknown) {
      const fp = JSON.stringify(payload);
      if (ref.current?.fp !== fp) ref.current = { fp, key: crypto.randomUUID() };
      return ref.current.key;
    },
    reset() { ref.current = null; },
  };
}
export const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600",
  approved: "bg-sky-500/15 text-sky-700",
  posting: "bg-sky-500/15 text-sky-700",
  posted: "bg-emerald-500/15 text-emerald-700",
  rejected: "bg-destructive/15 text-destructive",
  failed: "bg-destructive/15 text-destructive",
};
