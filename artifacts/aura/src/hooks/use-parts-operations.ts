import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch, getListPartsQueryKey } from "@workspace/api-client-react";

const API_BASE = "/api/parts/operations";

export function useGetLocations() {
  return useQuery({
    queryKey: ["parts-locations"],
    queryFn: () => customFetch<any[]>(`${API_BASE}/locations`),
  });
}

export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-locations"] }),
  });
}

export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      customFetch(`${API_BASE}/locations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-locations"] }),
  });
}

export function useGetBins(locationId?: number) {
  return useQuery({
    queryKey: ["parts-bins", locationId],
    queryFn: () =>
      customFetch<any[]>(
        `${API_BASE}/bins${locationId ? `?locationId=${locationId}` : ""}`
      ),
  });
}

export function useCreateBin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/bins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-bins"] }),
  });
}

export function useUpdateBin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      customFetch(`${API_BASE}/bins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-bins"] }),
  });
}

export function useGetInventoryLevels(params?: { locationId?: number; binId?: number; partId?: number }) {
  const search = new URLSearchParams();
  if (params?.locationId) search.set("locationId", String(params.locationId));
  if (params?.binId) search.set("binId", String(params.binId));
  if (params?.partId) search.set("partId", String(params.partId));
  
  return useQuery({
    queryKey: ["parts-levels", params],
    queryFn: () => customFetch<any[]>(`${API_BASE}/levels?${search.toString()}`),
  });
}

export function useGetInventoryLedger(params?: { locationId?: number; partId?: number; limit?: number }) {
  const search = new URLSearchParams();
  if (params?.locationId) search.set("locationId", String(params.locationId));
  if (params?.partId) search.set("partId", String(params.partId));
  if (params?.limit) search.set("limit", String(params.limit));
  
  return useQuery({
    queryKey: ["parts-ledger", params],
    queryFn: () => customFetch<any[]>(`${API_BASE}/ledger?${search.toString()}`),
  });
}

export function useGetInventoryHolds(params?: { status?: string; locationId?: number; partId?: number }) {
  const search = new URLSearchParams();
  if (params?.status) search.set("status", params.status);
  if (params?.locationId) search.set("locationId", String(params.locationId));
  if (params?.partId) search.set("partId", String(params.partId));
  
  return useQuery({
    queryKey: ["parts-holds", params],
    queryFn: () => customFetch<any[]>(`${API_BASE}/holds?${search.toString()}`),
  });
}

export function useReleaseHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch(`${API_BASE}/holds/${id}/release`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-holds"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: getListPartsQueryKey() });
    },
  });
}

export function useCreateHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/holds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-holds"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: getListPartsQueryKey() });
    },
  });
}

export function useConsumeHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch(`${API_BASE}/holds/${id}/consume`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-holds"] });
      qc.invalidateQueries({ queryKey: ["parts-ledger"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: getListPartsQueryKey() });
    },
  });
}

export function useExpireHolds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      customFetch(`${API_BASE}/holds/expire`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-holds"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: getListPartsQueryKey() });
    },
  });
}

export function useCreatePO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/purchase-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-po-queue"] }),
  });
}

export function useCreateIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-ledger"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: getListPartsQueryKey() });
    },
  });
}

export function useCreateAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-ledger"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: getListPartsQueryKey() });
    },
  });
}

export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-ledger"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: getListPartsQueryKey() });
    },
  });
}

export function useGetCycleCount(id: number | null) {
  return useQuery({
    queryKey: ["parts-cycle-counts", id],
    queryFn: () => customFetch<any>(`${API_BASE}/cycle-counts/${id}`),
    enabled: id !== null,
  });
}

export function useGetPOReviewQueue(params?: { status?: string; source?: string }) {
  const search = new URLSearchParams();
  if (params?.status) search.set("status", params.status);
  if (params?.source) search.set("source", params.source);
  
  return useQuery({
    queryKey: ["parts-po-queue", params],
    queryFn: () => customFetch<any[]>(`${API_BASE}/purchase-orders?${search.toString()}`),
  });
}

export function useGeneratePOs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { locationId?: number }) =>
      customFetch(`${API_BASE}/purchase-orders/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-po-queue"] }),
  });
}

export function useSpecialOrderPO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/purchase-orders/special-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-po-queue"] }),
  });
}

export function useAssignPOSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, supplierId }: { id: number; supplierId: number }) =>
      customFetch(`${API_BASE}/purchase-orders/${id}/supplier`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-po-queue"] }),
  });
}

export function useSendPO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      customFetch(`${API_BASE}/purchase-orders/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-po-queue"] }),
  });
}

export function useGetNotifications(status?: string) {
  return useQuery({
    queryKey: ["parts-notifications", status],
    queryFn: () => customFetch<any[]>(`${API_BASE}/notifications${status ? `?status=${status}` : ""}`),
  });
}

export function useGetNotificationSmsSettings() {
  return useQuery({
    queryKey: ["parts-notifications-sms-settings"],
    queryFn: () => customFetch<any>(`${API_BASE}/notifications/sms-settings`),
  });
}

export function useRetryNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch(`${API_BASE}/notifications/${id}/retry`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-notifications"] }),
  });
}

export function useGetCycleCounts() {
  return useQuery({
    queryKey: ["parts-cycle-counts"],
    queryFn: () => customFetch<any[]>(`${API_BASE}/cycle-counts`),
  });
}

export function useCreateCycleCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/cycle-counts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-cycle-counts"] }),
  });
}

export function useUpdateCycleCountLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lines }: { id: number; lines: any[] }) =>
      customFetch(`${API_BASE}/cycle-counts/${id}/lines`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-cycle-counts"] }),
  });
}

export function useApproveCycleCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch(`${API_BASE}/cycle-counts/${id}/approve`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-cycle-counts"] }),
  });
}

export function useCancelCycleCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch(`${API_BASE}/cycle-counts/${id}/cancel`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-cycle-counts"] }),
  });
}

export function useGetAging(params?: { locationId?: number; category?: string; thresholds?: string; format?: string }) {
  const search = new URLSearchParams();
  if (params?.locationId) search.set("locationId", String(params.locationId));
  if (params?.category) search.set("category", params.category);
  if (params?.thresholds) search.set("thresholds", params.thresholds);
  if (params?.format) search.set("format", params.format);
  
  return useQuery({
    queryKey: ["parts-aging", params],
    queryFn: async () => {
      if (params?.format === "csv") {
        const res = await fetch(`${API_BASE}/aging?${search.toString()}`);
        return res.text();
      }
      return customFetch<any>(`${API_BASE}/aging?${search.toString()}`);
    }
  });
}

export function useGetValuation(params?: { asOf?: string; locationId?: number }) {
  const search = new URLSearchParams();
  if (params?.asOf) search.set("asOf", params.asOf);
  if (params?.locationId) search.set("locationId", String(params.locationId));
  
  return useQuery({
    queryKey: ["parts-valuation", params],
    queryFn: () => customFetch<any>(`${API_BASE}/valuation?${search.toString()}`),
  });
}

export function useGetReplenishment(locationId?: number) {
  return useQuery({
    queryKey: ["parts-replenishment", locationId],
    queryFn: () => customFetch<any[]>(`${API_BASE}/replenishment${locationId ? `?locationId=${locationId}` : ""}`),
  });
}

export function useGetReconciliationQueue(status?: string) {
  return useQuery({
    queryKey: ["parts-reconciliation", status],
    queryFn: () => customFetch<any[]>(`${API_BASE}/reconciliation${status ? `?status=${status}` : ""}`),
  });
}

export function useSubmitReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      customFetch(`${API_BASE}/reconciliation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-reconciliation"] }),
  });
}

export function useResolveReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      customFetch(`${API_BASE}/reconciliation/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parts-reconciliation"] }),
  });
}

export function useCreateOtcInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { payload: any; idempotencyKey: string }) =>
      customFetch(`/api/parts/otc-invoices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": data.idempotencyKey,
        },
        body: JSON.stringify(data.payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parts-ledger"] });
      qc.invalidateQueries({ queryKey: ["parts-levels"] });
      qc.invalidateQueries({ queryKey: ["parts-locations"] });
    },
  });
}
