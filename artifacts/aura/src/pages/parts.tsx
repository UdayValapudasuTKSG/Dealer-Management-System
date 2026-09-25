import { useEffect, useState } from "react";
import {
  useListParts,
  useCreatePart,
  useUpdatePart,
  type Part,
  type PartInput,
  type PartUpdate,
  getListPartsQueryKey,
  useListSuppliers,
  useCreateSupplier,
  useUpdatePartsSupplierMetadata,
  useGetSupplierDeliveryHistory,
  getGetSupplierDeliveryHistoryQueryKey,
  getListSuppliersQueryKey,
  useListPartPurchases,
  useCreatePartPurchase,
  useReceivePartPurchase,
  getListPartPurchasesQueryKey,
  useGetPartsSettings,
  useUpdatePartsSettings,
  getGetPartsSettingsQueryKey,
  useListPurchaseOrders,
  useCreatePartsOperationalPurchaseOrder,
  useListPartsLocations,
  useUpdatePurchaseOrder,
  useReceivePurchaseOrder,
  type PurchaseOrder,
  getListPurchaseOrdersQueryKey,
  getListPartRequisitionsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUpload } from "@workspace/object-storage-web";
import { StyledSelect } from "@/components/ui/styled-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Plus,
  Package,
  Truck,
  ShoppingCart,
  AlertTriangle,
  Search,
  FileSpreadsheet,
  ClipboardList,
  Trash2,
  Loader2,
  Percent,
  Pencil,
  Download,
  FileText,
  MapPin,
  History,
  Lock,
  ClipboardCheck,
  BarChart3,
  Bell
} from "lucide-react";
import { useAuthz } from "@/lib/auth";
import { ImportPartsDialog } from "@/components/parts/import-parts-dialog";
import { PartBarcodeScanner } from "@/components/parts/part-barcode-scanner";
import {
  PricingBreakdownDialog,
  PricingDetailsEditor,
  pricingDetailsDraftError,
  pricingDetailsFromDraft,
  pricingDetailsToDraft,
} from "@/components/parts/pricing-details";

import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatGuyanaDate, useMoney } from "@/lib/format";

import { CreateInventoryRequisitionButton, RequisitionsWorkspace } from "@/components/parts/requisitions-workspace";

const TABS = [
  { key: "parts", label: "Parts", icon: Package },
  { key: "locations", label: "Locations & Bins", icon: MapPin },
  { key: "ledger", label: "Stock Ledger", icon: History },
  { key: "holds", label: "Holds", icon: Lock },
  { key: "cycle-counts", label: "Cycle Counts", icon: ClipboardCheck },
  { key: "requisitions", label: "Requisitions", icon: FileText },
  { key: "suppliers", label: "Suppliers", icon: Truck },
  { key: "orders", label: "Purchase Orders", icon: ClipboardList },
  { key: "purchases", label: "Quick Purchases", icon: ShoppingCart },
  { key: "reconciliation", label: "Reconciliation", icon: FileSpreadsheet },
  { key: "reporting", label: "Analysis", icon: BarChart3 },
  { key: "notifications", label: "Outbox", icon: Bell },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const apiBase = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Download the full parts inventory as an Excel workbook (re-importable). */
function ExportPartsButton() {
  const { toast } = useToast();
  const { activeDealer } = useAuthz();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const headers = new Headers({ "Cache-Control": "no-cache" });
      if (activeDealer?.dealerId != null) {
        headers.set("x-dealer-id", String(activeDealer.dealerId));
      }
      // Keep raw downloads aligned with the shared API client, including its
      // development-only persona header used by automated role testing.
      try {
        const testEmail = localStorage.getItem("aura-test-user-email");
        if (testEmail) headers.set("x-test-user-email", testEmail);
      } catch {
        // localStorage can be unavailable in privacy-restricted browsers.
      }
      const response = await fetch(`${apiBase()}/parts/export?download=${Date.now()}`, {
        cache: "no-store",
        credentials: "include",
        headers,
      });
      if (!response.ok) throw new Error(`Export failed (HTTP ${response.status})`);
      const bytes = await response.blob();
      if (bytes.size === 0) throw new Error("The downloaded workbook is empty.");
      // XLSX files are ZIP containers — validate the binary signature since
      // the reverse proxy can rewrite Content-Type.
      const sig = new Uint8Array(await bytes.slice(0, 4).arrayBuffer());
      const isXlsxZip =
        sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04;
      if (!isXlsxZip) {
        const text = await bytes.text();
        try {
          const problem = JSON.parse(text) as { error?: string; message?: string };
          throw new Error(problem.message ?? problem.error ?? "The Excel export failed.");
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error("The server did not return an Excel workbook.");
          }
          throw error;
        }
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? "aura-parts-inventory.xlsx";
      const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      toast({ title: "Excel download started" });
    } catch (error) {
      toast({
        title: "Excel download failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button
      variant="outline"
      disabled={downloading}
      onClick={download}
      className="rounded-full gap-2 border-white/15"
    >
      {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
      Export
    </Button>
  );
}

import { LocationsTab } from "@/components/parts/locations-tab";
import { LedgerTab, HoldsTab } from "@/components/parts/operations-tabs";
import { CycleCountsTab } from "@/components/parts/cycle-counts-tab";
import { ReconciliationTab } from "@/components/parts/reconciliation-tab";
import { POReviewTab } from "@/components/parts/po-review-tab";
import { NotificationsTab } from "@/components/parts/notifications-tab";
import { ReportingWorkspace } from "@/components/parts/reporting-workspace";

export default function Parts() {
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((item) => item.key === requested)
      ? (requested as TabKey)
      : "parts";
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") !== tab) {
      url.searchParams.set("tab", tab);
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, [tab]);

  return (
    <>
    <PageHero
      eyebrow="Supply Line"
      title="Parts"
      accent="Operations"
      subtitle="Stock, suppliers and purchasing — the workshop's supply line."
      action={
        tab === "parts" ? (
          <CreatePartDialog />
        ) : tab === "requisitions" ? (
          <CreateInventoryRequisitionButton />
        ) : tab === "suppliers" ? (
          <CreateSupplierDialog />
        ) : tab === "orders" ? (
          <CreatePurchaseOrderDialog />
        ) : tab === "purchases" ? (
          <CreatePurchaseDialog />
        ) : null
      }
    />
    <Page className="space-y-5">

      <div className="flex items-center gap-1 border-b border-white/10">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors",
              tab === t.key
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {tab === t.key && (
              <motion.span
                layoutId="parts-tab-active"
                className="absolute inset-x-2 -bottom-px h-0.5 bg-primary rounded-full"
              />
            )}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {tab === "parts" && <PartsTab />}
          {tab === "locations" && <LocationsTab />}
          {tab === "ledger" && <LedgerTab />}
          {tab === "holds" && <HoldsTab />}
          {tab === "cycle-counts" && <CycleCountsTab />}
          {tab === "requisitions" && <RequisitionsWorkspace />}
          {tab === "suppliers" && <SuppliersTab />}
          {tab === "orders" && <POReviewTab />}
          {tab === "purchases" && <PurchasesTab />}
          {tab === "reconciliation" && <ReconciliationTab />}
          {tab === "reporting" && <ReportingWorkspace />}
          {tab === "notifications" && <NotificationsTab />}
        </motion.div>
      </AnimatePresence>
    </Page>
    </>
  );
}

function CreatePartDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreatePart();
  const { data: suppliers } = useListSuppliers();
  return (
    <CreateRecordDialog
      title="Add Part"
      description="Register a stocked part with pricing and reorder level."
      pending={create.isPending}
      submitLabel="Add part"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Add Part
        </Button>
      }
      fields={[
        { name: "sku", label: "Part no.", type: "text", required: true, span: "half", placeholder: "13691814-00" },
        { name: "barcode", label: "Barcode", type: "text", span: "half", placeholder: "Scan or enter..." },
        { name: "name", label: "Part name", type: "text", required: true, span: "half", placeholder: "Engine oil filter" },
        { name: "make", label: "Vehicle make", type: "text", span: "half", placeholder: "Toyota" },
        { name: "description", label: "Description", type: "text", span: "half" },
        { name: "category", label: "Category", type: "text", span: "half", placeholder: "Service parts" },
        {
          name: "supplierId",
          label: "Supplier",
          type: "select",
          span: "half",
          options: suppliers?.map((s) => ({ value: String(s.id), label: s.name })) ?? [],
        },
        { 
          name: "costingMethod", 
          label: "Costing Method", 
          type: "select", 
          span: "half", 
          defaultValue: "average",
          options: [{value: "average", label: "Average"}, {value: "fifo", label: "FIFO"}, {value: "landed", label: "Landed"}]
        },
        { name: "unitCost", label: "Unit cost (GYD)", type: "number", span: "half", placeholder: "53908.78" },
        { name: "unitPrice", label: "Selling price pre-VAT (GYD)", type: "number", span: "half", placeholder: "80863.17" },
        { name: "stock", label: "Current stock", type: "number", span: "half", min: 0, placeholder: "0" },
        { name: "reorderLevel", label: "Reorder Min", type: "number", span: "half", placeholder: "3" },
        { name: "reorderMax", label: "Reorder Max", type: "number", span: "half", placeholder: "10" },
        { 
          name: "active", 
          label: "Status", 
          type: "select", 
          span: "half", 
          defaultValue: "true",
          options: [{value: "true", label: "Active"}, {value: "false", label: "Inactive"}]
        },
        {
          name: "pricingDetailsDraft",
          label: "Worksheet pricing details",
          type: "custom",
          span: "full",
          section: "Reference pricing",
          defaultValue: "{}",
          validate: pricingDetailsDraftError,
          render: (value, set) => <PricingDetailsEditor value={value} onChange={set} />,
        },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        const pricingDetails = pricingDetailsFromDraft(v.pricingDetailsDraft);
        const costingMethod =
          v.costingMethod === "fifo" ? "fifo" : v.costingMethod === "landed" ? "landed" : "average";
        const data: PartInput = {
          sku: String(v.sku),
          name: String(v.name),
          ...(v.barcode ? { barcode: String(v.barcode) } : {}),
          ...(v.description ? { description: String(v.description) } : {}),
          ...(v.make ? { make: String(v.make) } : {}),
          ...(v.category ? { category: String(v.category) } : {}),
          ...(v.supplierId ? { supplierId: Number(v.supplierId) } : {}),
          costingMethod,
          ...(v.unitCost !== undefined ? { unitCost: Number(v.unitCost) } : {}),
          ...(v.unitPrice !== undefined ? { unitPrice: Number(v.unitPrice) } : {}),
          ...(v.stock !== undefined ? { stock: Number(v.stock) } : {}),
          ...(v.reorderLevel !== undefined ? { reorderLevel: Number(v.reorderLevel) } : {}),
          ...(v.reorderMax !== undefined ? { reorderMax: Number(v.reorderMax) } : {}),
          ...(v.active !== undefined ? { active: v.active === "true" } : {}),
          ...(pricingDetails !== undefined ? { pricingDetails } : {}),
        };
        await create.mutateAsync({
          data,
        });
        queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
        toast({ title: "Part added" });
      }}
    />
  );
}

function EditPartDialog({ part }: { part: Part & { barcode?: string; description?: string; costingMethod?: string; reorderMax?: number; active?: boolean; quantityAvailable?: number; quantityReserved?: number } }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdatePart();
  const { data: suppliers } = useListSuppliers();
  return (
    <CreateRecordDialog
      title={`Edit ${part.name}`}
      description="Update pricing, stock and details for this part."
      pending={update.isPending}
      submitLabel="Save changes"
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
          aria-label={`Edit ${part.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      }
      fields={[
        { name: "sku", label: "Part no.", type: "text", required: true, span: "half", defaultValue: part.sku },
        { name: "barcode", label: "Barcode", type: "text", span: "half", defaultValue: part.barcode ?? "" },
        { name: "name", label: "Part name", type: "text", required: true, span: "half", defaultValue: part.name },
        { name: "make", label: "Vehicle make", type: "text", span: "half", defaultValue: part.make ?? "" },
        { name: "description", label: "Description", type: "text", span: "half", defaultValue: part.description ?? "" },
        { name: "category", label: "Category", type: "text", span: "half", defaultValue: part.category ?? "" },
        {
          name: "supplierId",
          label: "Supplier",
          type: "select",
          span: "half",
          defaultValue: part.supplierId ? String(part.supplierId) : "",
          options: suppliers?.map((s) => ({ value: String(s.id), label: s.name })) ?? [],
        },
        { 
          name: "costingMethod", 
          label: "Costing Method", 
          type: "select", 
          span: "half", 
          defaultValue: part.costingMethod ?? "average",
          options: [{value: "average", label: "Average"}, {value: "fifo", label: "FIFO"}, {value: "landed", label: "Landed"}]
        },
        { name: "unitCost", label: "Unit cost (GYD)", type: "number", span: "half", defaultValue: String(part.unitCost ?? 0) },
        { name: "unitPrice", label: "Selling price pre-VAT (GYD)", type: "number", span: "half", defaultValue: String(part.unitPrice ?? 0) },
        { name: "stock", label: "Current stock", type: "number", span: "half", min: 0, defaultValue: String(part.stock ?? 0) },
        { name: "reorderLevel", label: "Reorder Min", type: "number", span: "half", defaultValue: String(part.reorderLevel ?? 5) },
        { name: "reorderMax", label: "Reorder Max", type: "number", span: "half", defaultValue: String(part.reorderMax ?? 10) },
        { 
          name: "active", 
          label: "Status", 
          type: "select", 
          span: "half", 
          defaultValue: part.active ? "true" : "false",
          options: [{value: "true", label: "Active"}, {value: "false", label: "Inactive"}]
        },
        {
          name: "pricingDetailsDraft",
          label: "Worksheet pricing details",
          type: "custom",
          span: "full",
          section: "Reference pricing",
          defaultValue: pricingDetailsToDraft(part.pricingDetails),
          validate: pricingDetailsDraftError,
          render: (value, set) => <PricingDetailsEditor value={value} onChange={set} allowClear />,
        },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        const pricingDetails = pricingDetailsFromDraft(v.pricingDetailsDraft);
        const costingMethod =
          v.costingMethod === "fifo" ? "fifo" : v.costingMethod === "landed" ? "landed" : "average";
        const updateData: PartUpdate = {
          sku: String(v.sku),
          name: String(v.name),
          ...(v.barcode !== undefined ? { barcode: String(v.barcode) } : {}),
          ...(v.description !== undefined ? { description: String(v.description) } : {}),
          make: v.make !== undefined ? String(v.make) : null,
          ...(v.category !== undefined ? { category: String(v.category) } : {}),
          ...(v.supplierId ? { supplierId: Number(v.supplierId) } : {}),
          costingMethod,
          unitCost: v.unitCost === "" ? 0 : Number(v.unitCost),
          unitPrice: v.unitPrice === "" ? 0 : Number(v.unitPrice),
          stock: v.stock === "" ? 0 : Number(v.stock),
          reorderLevel: v.reorderLevel === "" ? 5 : Number(v.reorderLevel),
          reorderMax: v.reorderMax === "" ? 10 : Number(v.reorderMax),
          active: v.active === "true",
          ...(pricingDetails !== undefined ? { pricingDetails } : {}),
        };
        await update.mutateAsync({
          id: part.id,
          data: updateData,
        });
        queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
        toast({ title: "Part updated" });
      }}
    />
  );
}

function MarkupEditor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings } = useGetPartsSettings();
  const update = useUpdatePartsSettings();
  const [value, setValue] = useState<string>("");

  useEffect(() => {
    if (settings) setValue(String(settings.markupPercent));
  }, [settings]);

  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 500) {
      toast({ title: "Invalid markup", description: "Enter a percentage between 0 and 500.", variant: "destructive" });
      return;
    }
    if (settings && n === settings.markupPercent) return;
    await update.mutateAsync({ data: { markupPercent: n } });
    queryClient.invalidateQueries({ queryKey: getGetPartsSettingsQueryKey() });
    toast({ title: "Markup updated", description: `Imports now price at cost + ${n}%.` });
  };

  return (
    <div
      className="flex items-center gap-1.5 rounded-full bg-white/[0.03] border border-white/10 px-3 h-10"
      title="Cost-plus markup used to auto-price imported parts"
    >
      <Percent className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground whitespace-nowrap">Markup</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-14 h-7 px-1.5 text-right border-none bg-transparent text-sm tabular-nums"
        inputMode="decimal"
      />
      <span className="text-xs text-muted-foreground">%</span>
    </div>
  );
}

const PARTS_PAGE_SIZE = 24;

function PartsTab() {
  const money = useMoney();
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(1);
  const { data: settings } = useGetPartsSettings();
  const { data: allParts, isLoading } = useListParts({
    ...(search ? { search } : {}),
    ...(lowOnly ? { lowStock: "1" } : {}),
  });

  const lowCount = allParts?.filter((p) => p.stock <= p.reorderLevel).length ?? 0;
  const { density, setDensity, layout, setLayout } = useViewMode("parts");

  const total = allParts?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PARTS_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const parts = allParts?.slice(
    (safePage - 1) * PARTS_PAGE_SIZE,
    safePage * PARTS_PAGE_SIZE,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name or SKU..."
            className="pl-10 rounded-full bg-white/[0.03] border-white/10"
          />
        </div>
        <Button
          variant={lowOnly ? "default" : "outline"}
          onClick={() => {
            setLowOnly((v) => !v);
            setPage(1);
          }}
          className={cn(
            "rounded-full gap-2",
            lowOnly
              ? "bg-primary hover:bg-primary/90 text-white"
              : "border-white/15",
          )}
        >
          <AlertTriangle className="w-4 h-4" />
          Reorder alerts{lowCount > 0 && !lowOnly ? ` (${lowCount})` : ""}
        </Button>
        <ImportPartsDialog
          markupPercent={settings?.markupPercent}
          trigger={
            <Button variant="outline" className="rounded-full gap-2 border-white/15">
              <FileSpreadsheet className="w-4 h-4" />
              Import
            </Button>
          }
        />
        <ExportPartsButton />
        <MarkupEditor />
        <ViewControls
          layout={layout}
          onLayoutChange={setLayout}
          density={density}
          onDensityChange={setDensity}
        />
      </div>

      {isLoading ? (
        <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />
      ) : !parts?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
          <Package className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">No parts found.</p>
        </div>
      ) : layout === "list" ? (
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Part</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">SKU / Barcode</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Category</th>
                <th className="px-4 py-3 font-semibold text-right">Available</th>
                <th className="px-4 py-3 font-semibold text-right hidden md:table-cell">Cost</th>
                <th className="px-4 py-3 font-semibold text-right">Price</th>
                <th className="px-4 py-3 font-semibold text-right w-20" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {(parts as (Part & { barcode?: string; description?: string; active?: boolean; quantityAvailable?: number; quantityReserved?: number })[]).map((p) => {
                const low = (p.quantityAvailable ?? 0) <= (p.reorderLevel ?? 0);
                return (
                  <tr key={p.id} className="border-b border-white/5 hover:bg-foreground/[0.03] transition-colors">
                    <td className={cn("px-4 font-medium", density === "compact" ? "py-2.5" : "py-3.5")}>
                      {p.name}
                      {p.active === false && (
                        <span className="ml-2 rounded-full bg-white/[0.08] text-muted-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                          Inactive
                        </span>
                      )}
                      {low && (
                        <span className="ml-2 rounded-full bg-primary/15 text-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                          Reorder
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden md:table-cell">
                      {p.sku}
                      {p.barcode && <div className="text-[10px] opacity-70">{p.barcode}</div>}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">
                      {p.make && <div className="text-foreground/80">{p.make}</div>}
                      {p.category}
                    </td>
                    <td className={cn("px-4 py-2 text-right tabular-nums font-semibold", low && "text-primary")}>
                      {p.quantityAvailable ?? 0} <span className="text-muted-foreground font-normal">/ {p.reorderLevel}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums hidden md:table-cell">
                      {money.gyd(p.unitCost)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {money.gyd(p.unitPrice)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <PricingBreakdownDialog part={p} />
                      <EditPartDialog part={p} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(parts as (Part & { barcode?: string; description?: string; active?: boolean; quantityAvailable?: number; quantityReserved?: number })[]).map((p) => {
            const low = (p.quantityAvailable ?? 0) <= (p.reorderLevel ?? 0);
            return (
              <Card key={p.id} className="glass-panel border-none rounded-3xl relative overflow-hidden">
                {low && (
                  <div className="absolute top-0 inset-x-0 h-1 bg-primary" />
                )}
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                        {p.sku}
                      </div>
                      <h3 className="font-bold leading-tight">{p.name}</h3>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {[p.make, p.category].filter(Boolean).join(" · ")}
                        {p.active === false && (
                          <span className="ml-2 rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                            Inactive
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {low && (
                        <Badge className="bg-primary/15 text-primary border-none rounded-full text-[10px] font-bold uppercase tracking-widest gap-1">
                          <AlertTriangle className="w-3 h-3" /> Reorder
                        </Badge>
                      )}
                      <PricingBreakdownDialog part={p} />
                      <EditPartDialog part={p} />
                    </div>
                  </div>
                  <div className="flex items-end justify-between">
                    <div>
                      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-0.5">
                        Available
                      </div>
                      <div
                        className={cn(
                          "font-light text-2xl tracking-tight",
                          low && "text-primary",
                        )}
                      >
                        {p.quantityAvailable ?? 0}
                        <span className="text-sm text-muted-foreground"> / min {p.reorderLevel}</span>
                      </div>
                      {p.quantityReserved ? (
                        <div className="text-[10px] text-amber-500 mt-1 uppercase tracking-wider font-semibold">
                          +{p.quantityReserved} reserved
                        </div>
                      ) : null}
                    </div>
                    <div className="text-right text-sm">
                      <div className="text-muted-foreground">Cost {money.gyd(p.unitCost)}</div>
                      <div className="font-medium">Price {money.gyd(p.unitPrice)}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {total > PARTS_PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-xs text-muted-foreground tabular-nums">
            Showing {(safePage - 1) * PARTS_PAGE_SIZE + 1}–
            {Math.min(safePage * PARTS_PAGE_SIZE, total)} of {total} parts
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-white/15 text-xs h-8"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              Page {safePage} / {pageCount}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-white/15 text-xs h-8"
              disabled={safePage >= pageCount}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateSupplierDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateSupplier();
  return (
    <CreateRecordDialog
      title="Add Supplier"
      description="Register a parts vendor."
      pending={create.isPending}
      submitLabel="Add supplier"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Add Supplier
        </Button>
      }
      fields={[
        { name: "name", label: "Company", type: "text", required: true, span: "full", placeholder: "Bosch Guyana Ltd" },
        { name: "contactName", label: "Contact", type: "text", span: "half" },
        { name: "email", label: "Email", type: "email", span: "half" },
        { name: "phone", label: "Phone", type: "phone", span: "half" },
        { name: "address", label: "Address", type: "text", span: "full" },
        { name: "leadTimeDays", label: "Lead Time (Days)", type: "number", span: "half" },
      ]}
      onSubmit={async (values) => {
        await create.mutateAsync({ data: values as never });
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        toast({ title: "Supplier added" });
      }}
    />
  );
}

function SuppliersTab() {
  const money = useMoney();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: suppliers, isLoading } = useListSuppliers();
  const updateMetadata = useUpdatePartsSupplierMetadata();
  const [selectedSupplierId, setSelectedSupplierId] = useState<number | null>(null);
  const [editingSupplierId, setEditingSupplierId] = useState<number | null>(null);
  const [supplierAddress, setSupplierAddress] = useState("");
  const [supplierLeadTime, setSupplierLeadTime] = useState("");
  const selectedSupplier = suppliers?.find((supplier) => supplier.id === selectedSupplierId);
  const editingSupplier = suppliers?.find((supplier) => supplier.id === editingSupplierId);
  const { data: history, isLoading: historyLoading } = useGetSupplierDeliveryHistory(
    selectedSupplierId ?? 0,
    {
      query: {
        queryKey: getGetSupplierDeliveryHistoryQueryKey(selectedSupplierId ?? 0),
        enabled: selectedSupplierId != null,
      },
    },
  );
  if (isLoading) return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!suppliers?.length)
    return (
      <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
        <Truck className="w-8 h-8 text-muted-foreground" />
        <p className="text-muted-foreground">No suppliers registered yet.</p>
      </div>
    );
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {suppliers.map((s) => (
        <Card
          key={s.id}
          className="glass-panel border-none rounded-3xl cursor-pointer transition-transform hover:-translate-y-0.5"
          onClick={() => setSelectedSupplierId(s.id)}
        >
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-center">
                <Truck className="w-4 h-4 text-muted-foreground" />
              </div>
              <h3 className="font-bold">{s.name}</h3>
            </div>
            <div className="text-sm text-muted-foreground space-y-0.5">
              {s.contactName && <div>{s.contactName}</div>}
              {s.email && <div>{s.email}</div>}
              {s.phone && <div>{s.phone}</div>}
              <div>{s.address || "Address not set"}</div>
              <div>{s.leadTimeDays != null ? `${s.leadTimeDays} day lead time` : "Lead time not set"}</div>
            </div>
            <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-primary">View delivery history</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditingSupplierId(s.id);
                  setSupplierAddress(s.address ?? "");
                  setSupplierLeadTime(s.leadTimeDays != null ? String(s.leadTimeDays) : "");
                }}
                className="h-7 gap-1 text-xs"
              >
                <Pencil className="w-3 h-3" /> Settings
              </Button>
            </div>
          </CardContent>
        </Card>
        ))}
      </div>
      <Dialog
        open={selectedSupplierId != null}
        onOpenChange={(open) => { if (!open) setSelectedSupplierId(null); }}
      >
        <DialogContent className="max-w-4xl glass-panel border-none">
          <DialogHeader>
            <DialogTitle>{selectedSupplier?.name ?? "Supplier"} · Delivery History</DialogTitle>
            <DialogDescription>
              Every documented shipment received from this supplier, newest first.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[72vh] overflow-y-auto pr-2 space-y-4">
            {historyLoading ? (
              <div className="h-40 rounded-2xl bg-white/[0.04] animate-pulse" />
            ) : !history?.deliveries.length ? (
              <div className="rounded-2xl border border-dashed border-white/10 py-14 text-center text-muted-foreground">
                No documented deliveries have been received from this supplier yet.
              </div>
            ) : (
              history.deliveries.map((delivery) => {
                const units = delivery.lines.reduce((sum, line) => sum + line.quantity, 0);
                const value = delivery.lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
                return (
                  <Card key={delivery.id} className="border border-white/5 bg-white/[0.025] rounded-2xl">
                    <CardContent className="p-5 space-y-4">
                      <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div>
                          <div className="font-semibold">PO #{delivery.purchaseOrderId}</div>
                          <div className="text-sm text-muted-foreground">
                            {formatGuyanaDate(delivery.receivedAt)} · Delivery note {delivery.deliveryNoteNumber}
                          </div>
                        </div>
                        <Badge className={cn(
                          "border-none rounded-full text-[10px] font-bold uppercase tracking-widest",
                          delivery.condition === "accepted"
                            ? "bg-primary/15 text-primary"
                            : "bg-red-500/15 text-red-300",
                        )}>
                          {delivery.condition === "accepted" ? "Accepted" : "Accepted with discrepancy"}
                        </Badge>
                      </div>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
                        <div><div className="text-xs text-muted-foreground">Received by</div><div>{delivery.receivedByName}</div></div>
                        <div><div className="text-xs text-muted-foreground">Location</div><div>{delivery.warehouseLocation}</div></div>
                        <div><div className="text-xs text-muted-foreground">Supplier invoice</div><div>{delivery.supplierInvoiceNumber || "Not recorded"}</div></div>
                        <div><div className="text-xs text-muted-foreground">Shipment total</div><div>{units} units · {money.gyd(value)}</div></div>
                      </div>
                      <div className="rounded-xl border border-white/5 divide-y divide-white/5">
                        {delivery.lines.map((line) => (
                          <div key={line.purchaseOrderLineId} className="px-3 py-2 flex justify-between gap-4 text-sm">
                            <span>{line.partName}</span>
                            <span className="text-muted-foreground tabular-nums">{line.quantity} × {money.gyd(line.unitCost)}</span>
                          </div>
                        ))}
                      </div>
                      {delivery.notes && <div className="text-sm text-muted-foreground">{delivery.notes}</div>}
                      <div className="flex flex-wrap gap-2">
                        {delivery.documents.map((document) => (
                          <Button key={document.objectPath} asChild size="sm" variant="outline" className="rounded-full">
                            <a href={`/api/storage${document.objectPath}`} target="_blank" rel="noreferrer">
                              <Download className="w-3.5 h-3.5 mr-2" />
                              {document.fileName}
                            </a>
                          </Button>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={editingSupplierId != null}
        onOpenChange={(open) => { if (!open) setEditingSupplierId(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSupplier?.name ?? "Supplier"} settings</DialogTitle>
            <DialogDescription>Address and lead time are used for procurement planning.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Address</label>
              <Textarea value={supplierAddress} onChange={(event) => setSupplierAddress(event.target.value)} placeholder="Supplier address" />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Lead time (days)</label>
              <Input type="number" min={0} step={1} value={supplierLeadTime} onChange={(event) => setSupplierLeadTime(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSupplierId(null)}>Cancel</Button>
            <Button
              disabled={updateMetadata.isPending}
              onClick={async () => {
                if (!editingSupplierId) return;
                const leadTimeDays = Number(supplierLeadTime);
                if (supplierLeadTime === "" || !Number.isSafeInteger(leadTimeDays) || leadTimeDays < 0) {
                  toast({ title: "Enter a valid lead time", variant: "destructive" });
                  return;
                }
                try {
                  await updateMetadata.mutateAsync({
                    id: editingSupplierId,
                    data: { address: supplierAddress.trim() || null, leadTimeDays },
                  });
                  await queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
                  toast({ title: "Supplier settings saved" });
                  setEditingSupplierId(null);
                } catch (error) {
                  toast({
                    title: "Could not save supplier settings",
                    description: error instanceof Error ? error.message : "Please try again.",
                    variant: "destructive",
                  });
                }
              }}
            >
              {updateMetadata.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreatePurchaseDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreatePartPurchase();
  const { data: parts } = useListParts();
  const { data: suppliers } = useListSuppliers();
  return (
    <CreateRecordDialog
      title="Record Purchase"
      description="Receiving a purchase increments stock immediately."
      pending={create.isPending}
      submitLabel="Record purchase"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Record Purchase
        </Button>
      }
      fields={[
        {
          name: "partId",
          label: "Part",
          type: "select",
          required: true,
          span: "full",
          options:
            parts?.map((p) => ({
              value: String(p.id),
              label: `${p.name} (${p.sku}) — ${p.stock} in stock`,
            })) ?? [],
        },
        {
          name: "supplierId",
          label: "Supplier",
          type: "select",
          span: "half",
          options: suppliers?.map((s) => ({ value: String(s.id), label: s.name })) ?? [],
        },
        { name: "quantity", label: "Quantity", type: "number", required: true, span: "half", defaultValue: "1" },
        { name: "unitCost", label: "Unit cost", type: "number", span: "half" },
        { name: "reference", label: "PO / reference", type: "text", span: "half" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        await create.mutateAsync({
          data: {
            partId: Number(v.partId),
            quantity: Number(v.quantity),
            ...(v.supplierId ? { supplierId: Number(v.supplierId) } : {}),
            ...(v.unitCost ? { unitCost: Number(v.unitCost) } : {}),
            ...(v.reference ? { reference: String(v.reference) } : {}),
          },
        });
        queryClient.invalidateQueries({ queryKey: getListPartPurchasesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
        toast({ title: "Purchase recorded", description: "Stock updated." });
      }}
    />
  );
}

function ReceivePurchaseDialog({ purchaseId, outstanding }: { purchaseId: number; outstanding: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const receive = useReceivePartPurchase();
  return (
    <CreateRecordDialog
      title="Receive Stock"
      description={`Post received units against this order (${outstanding} outstanding). Backordered job lines are filled automatically.`}
      pending={receive.isPending}
      submitLabel="Receive"
      trigger={
        <Button size="sm" className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs gap-1.5">
          <Package className="w-3.5 h-3.5" /> Receive
        </Button>
      }
      fields={[
        { name: "qtyReceived", label: "Quantity received", type: "number", required: true, span: "full", defaultValue: String(outstanding) },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        try {
          await receive.mutateAsync({ id: purchaseId, data: { qtyReceived: Number(v.qtyReceived) } });
          queryClient.invalidateQueries({ queryKey: getListPartPurchasesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
          toast({ title: "Stock received", description: "Inventory updated; backorders released." });
        } catch (e: unknown) {
          const msg =
            (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            "Could not receive stock.";
          toast({ title: "Receive failed", description: msg, variant: "destructive" });
          throw e;
        }
      }}
    />
  );
}

const PO_STATUS_STYLES: Record<string, string> = {
  draft: "bg-white/[0.08] text-muted-foreground",
  ordered: "bg-sky-500/15 text-sky-400",
  partially_received: "bg-amber-500/15 text-amber-400",
  received: "bg-primary/15 text-primary",
  cancelled: "bg-white/[0.05] text-muted-foreground/60",
};

function CreatePurchaseOrderDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: parts } = useListParts();
  const { data: suppliers } = useListSuppliers();
  const { data: locations } = useListPartsLocations();
  const create = useCreatePartsOperationalPurchaseOrder();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<string>("");
  const [locationId, setLocationId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<{
    partId: string;
    quantity: string;
    unitCost: string;
    freight: string;
    duty: string;
    handling: string;
    other: string;
  }[]>([
    { partId: "", quantity: "1", unitCost: "", freight: "", duty: "", handling: "", other: "" },
  ]);

  const reset = () => {
    setSupplierId("");
    setLocationId("");
    setExpectedDate("");
    setReference("");
    setLines([{ partId: "", quantity: "1", unitCost: "", freight: "", duty: "", handling: "", other: "" }]);
  };

  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    const parsedLines = lines
      .filter((l) => l.partId)
      .map((line) => {
        const landedCostComponents = Object.fromEntries(
          (["freight", "duty", "handling", "other"] as const)
            .filter((key) => line[key] !== "")
            .map((key) => [key, Number(line[key])]),
        );
        return {
          partId: Number(line.partId),
          quantity: Math.max(1, Math.floor(Number(line.quantity) || 1)),
          unitCost: Number(line.unitCost),
          ...(Object.keys(landedCostComponents).length ? { landedCostComponents } : {}),
        };
      });
    if (parsedLines.length === 0) {
      toast({ title: "Add at least one part line", variant: "destructive" });
      return;
    }
    if (!locationId) {
      toast({ title: "Select a destination location", variant: "destructive" });
      return;
    }
    if (parsedLines.some((line) => !Number.isFinite(line.unitCost) || line.unitCost < 0)) {
      toast({ title: "Enter a valid unit cost for every line", variant: "destructive" });
      return;
    }
    try {
      await create.mutateAsync({
        data: {
          ...(supplierId ? { supplierId: Number(supplierId) } : {}),
          locationId: Number(locationId),
          ...(expectedDate ? { expectedDate } : {}),
          ...(reference ? { notes: reference } : {}),
          lines: parsedLines,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
      toast({
        title: "Draft PO saved",
        description: `${parsedLines.length} line${parsedLines.length === 1 ? "" : "s"} ready for review.`,
      });
      setOpen(false);
      reset();
    } catch {
      toast({ title: "Could not create the purchase order", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2">
          <Plus className="w-4 h-4" />
          New Purchase Order
        </Button>
      </DialogTrigger>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[860px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl tracking-tight">Raise a purchase order</DialogTitle>
          <DialogDescription>
            Multi-line order to a supplier — receiving it adds stock and releases any waiting job
            cards.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Supplier</label>
            <StyledSelect
              value={supplierId}
              onValueChange={setSupplierId}
              options={[
                { value: "", label: "— None —" },
                ...(suppliers?.map((s) => ({
                  value: String(s.id),
                  label: s.name,
                })) ?? []),
              ]}
              className="w-full h-10 rounded-xl bg-white/[0.04] border border-white/10 px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Destination location *</label>
            <StyledSelect
              value={locationId}
              onValueChange={setLocationId}
              options={[
                { value: "", label: "Select location…" },
                ...(locations?.filter((location) => location.active).map((location) => ({
                  value: String(location.id),
                  label: location.name,
                })) ?? []),
              ]}
              className="w-full h-10 rounded-xl bg-white/[0.04] border border-white/10 px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Expected receipt</label>
            <Input
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
              className="h-10 rounded-xl bg-white/[0.04] border-white/10"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground mb-1 block">Reference</label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. Monthly restock"
              className="h-10 rounded-xl bg-white/[0.04] border-white/10"
            />
          </div>
        </div>
        <div className="space-y-2">
            <div className="grid grid-cols-[1fr_64px_92px_repeat(4,72px)_36px] gap-2 text-[10px] uppercase tracking-widest text-muted-foreground px-1">
            <span>Part</span>
            <span>Qty</span>
            <span>Unit cost</span>
              <span>Freight</span>
              <span>Duty</span>
              <span>Handling</span>
              <span>Other</span>
            <span />
          </div>
          {lines.map((line, i) => (
            <div key={i} className="space-y-1">
            <div className="grid grid-cols-[1fr_64px_92px_repeat(4,72px)_36px] gap-2">
              <StyledSelect
                value={line.partId}
                onValueChange={(value) => {
                  const part = parts?.find((p) => p.id === Number(value));
                  setLine(i, {
                    partId: value,
                    unitCost: part ? String(part.unitCost) : line.unitCost,
                  });
                }}
                options={[
                  { value: "", label: "Select part…" },
                  ...(parts?.map((p) => ({
                    value: String(p.id),
                    label: `${p.sku} — ${p.name}`,
                  })) ?? []),
                ]}
                className="h-10 rounded-xl bg-white/[0.04] border border-white/10 px-3 text-sm min-w-0"
              />
              <Input
                type="number"
                min={1}
                value={line.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
                className="h-10 rounded-xl bg-white/[0.04] border-white/10 text-right"
              />
              {(["freight", "duty", "handling", "other"] as const).map((key) => (
                <Input
                  key={key}
                  type="number"
                  min={0}
                  step="0.01"
                  value={line[key]}
                  onChange={(event) => setLine(i, { [key]: event.target.value })}
                  placeholder="0"
                  aria-label={`${key} total for line ${i + 1}`}
                  className="h-10 rounded-xl bg-white/[0.04] border-white/10 text-right"
                />
              ))}
              <Input
                type="number"
                min={0}
                value={line.unitCost}
                onChange={(e) => setLine(i, { unitCost: e.target.value })}
                placeholder="auto"
                className="h-10 rounded-xl bg-white/[0.04] border-white/10 text-right"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-9 rounded-xl text-muted-foreground hover:text-destructive"
                onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                disabled={lines.length === 1}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
            <p className="pr-10 text-right text-[11px] text-muted-foreground">
              Line total: {(
                Math.max(1, Number(line.quantity) || 1) * (Number(line.unitCost) || 0) +
                Number(line.freight || 0) +
                Number(line.duty || 0) +
                Number(line.handling || 0) +
                Number(line.other || 0)
              ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            </div>
          ))}
          <Button
            variant="outline"
            className="rounded-full gap-2 border-white/15 h-9"
            onClick={() => setLines((prev) => [...prev, { partId: "", quantity: "1", unitCost: "", freight: "", duty: "", handling: "", other: "" }])}
          >
            <Plus className="w-4 h-4" />
            Add line
          </Button>
        </div>
        <DialogFooter className="items-center gap-3">
          <p className="mr-auto text-xs text-muted-foreground">The order remains a draft until supplier review and approval.</p>
          <Button
            onClick={submit}
            disabled={create.isPending}
            className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
          >
            {create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PurchaseOrdersTab() {
  const money = useMoney();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: orders, isLoading } = useListPurchaseOrders();
  const { data: suppliers } = useListSuppliers();
  const update = useUpdatePurchaseOrder();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [receivingPo, setReceivingPo] = useState<PurchaseOrder | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const downloadPdf = async (id: number) => {
    setDownloadingId(id);
    try {
      const blob = await customFetch<Blob>(
        `/api/purchase-orders/${id}/pdf?download=${Date.now()}`,
        { responseType: "blob", cache: "no-store", headers: { "Cache-Control": "no-cache" } },
      );
      const signature = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
      if (signature !== "%PDF-") {
        const body = await blob.text();
        let message = "The server did not return a PDF.";
        try {
          const error = JSON.parse(body) as { error?: string; message?: string };
          message = error.message ?? error.error ?? message;
        } catch { /* Non-JSON response. */ }
        throw new Error(message);
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `purchase-order-${id}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast({ title: "PDF download failed", description: (error as Error).message, variant: "destructive" });
    } finally {
      setDownloadingId(null);
    }
  };

  const supplierName = (id: number | null | undefined) =>
    id == null ? "No supplier" : (suppliers?.find((s) => s.id === id)?.name ?? `Supplier #${id}`);

  const act = async (id: number, fn: () => Promise<unknown>, done: string) => {
    setBusyId(id);
    try {
      await fn();
      queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListPartRequisitionsQueryKey() });
      toast({ title: done });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || (err as Error).message;
      toast({
        title: "Action failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!orders?.length)
    return (
      <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
        <ClipboardList className="w-8 h-8 text-muted-foreground" />
        <p className="text-muted-foreground">No purchase orders yet — raise one to restock.</p>
      </div>
    );

  return (
    <div className="grid grid-cols-1 gap-3">
      {orders.map((po) => {
        const totalValue = po.lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
        const outstanding = po.lines.reduce(
          (sum, l) => sum + Math.max(0, l.quantity - l.qtyReceived),
          0,
        );
        const busy = busyId === po.id;
        return (
          <Card key={po.id} className="glass-panel border-none rounded-2xl">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <div className="font-medium">
                    PO #{po.id} · {supplierName(po.supplierId)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {po.reference && `${po.reference} · `}
                    Raised {formatGuyanaDate(po.createdAt)}
                    {po.expectedDate &&
                      ` · Expected ${formatGuyanaDate(String(po.expectedDate).slice(0, 10))}`}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="font-light text-xl">{money.gyd(totalValue)}</div>
                    <div className="text-xs text-muted-foreground">
                      {po.lines.length} line{po.lines.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Badge
                    className={cn(
                      "border-none rounded-full text-[10px] font-bold uppercase tracking-widest",
                      PO_STATUS_STYLES[po.status] ?? PO_STATUS_STYLES.draft,
                    )}
                  >
                    {po.status.replace("_", " ")}
                  </Badge>
                </div>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/5 divide-y divide-white/5">
                {po.lines.map((l) => (
                  <div key={l.id} className="px-4 py-2 flex items-center justify-between text-sm">
                    <span className="min-w-0 truncate">
                      {l.partName}
                      {l.jobCardId != null && (
                        <span className="text-xs text-muted-foreground"> · Job card #{l.jobCardId}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums shrink-0 ml-3">
                      {l.qtyReceived}/{l.quantity} @ {money.gyd(l.unitCost)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" disabled={downloadingId === po.id}
                  onClick={() => downloadPdf(po.id)} className="rounded-full px-5 border-white/15">
                  <Download className="w-4 h-4 mr-2" />
                  {downloadingId === po.id ? "Preparing PDF…" : "Download PDF"}
                </Button>
              </div>
              {(po.status === "draft" ||
                po.status === "ordered" ||
                po.status === "partially_received") && (
                <div className="flex items-center gap-2 justify-end">
                  {po.status === "draft" && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        act(
                          po.id,
                          () => update.mutateAsync({ id: po.id, data: { status: "ordered" } }),
                          `PO #${po.id} placed with the supplier`,
                        )
                      }
                      className="bg-primary hover:bg-primary/90 text-white rounded-full px-5"
                    >
                      Place order
                    </Button>
                  )}
                  {(po.status === "ordered" || po.status === "partially_received") && (
                    <Button
                      size="sm"
                      disabled={busy || outstanding === 0}
                      onClick={() => setReceivingPo(po)}
                      className="bg-primary hover:bg-primary/90 text-white rounded-full px-5"
                    >
                      Receive shipment ({outstanding})
                    </Button>
                  )}
                  {(po.status === "draft" || po.status === "ordered") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        act(
                          po.id,
                          () => update.mutateAsync({ id: po.id, data: { status: "cancelled" } }),
                          `PO #${po.id} cancelled`,
                        )
                      }
                      className="rounded-full px-5 border-white/15 text-muted-foreground"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
      <ReceivePurchaseOrderDialog
        order={receivingPo}
        onOpenChange={(open) => { if (!open) setReceivingPo(null); }}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListPartRequisitionsQueryKey() });
        }}
      />
    </div>
  );
}

function ReceivePurchaseOrderDialog({
  order,
  onOpenChange,
  onSuccess,
}: {
  order: PurchaseOrder | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const receive = useReceivePurchaseOrder();
  const { data: parts } = useListParts();
  const { uploadFile } = useUpload();
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [deliveryNoteNumber, setDeliveryNoteNumber] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [warehouseLocation, setWarehouseLocation] = useState("Parts stores");
  const [condition, setCondition] = useState<"accepted" | "accepted_with_discrepancy">("accepted");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [quantities, setQuantities] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!order) return;
    setReceivedAt(new Date().toISOString().slice(0, 16));
    setDeliveryNoteNumber("");
    setSupplierInvoiceNumber("");
    setWarehouseLocation("Parts stores");
    setCondition("accepted");
    setNotes("");
    setFiles([]);
    setQuantities(Object.fromEntries(order.lines.map((line) => [line.id, 0])));
  }, [order]);

  const handleBarcode = (barcode: string) => {
    if (!order) return;
    const part = parts?.find((candidate) => candidate.barcode?.trim() === barcode.trim());
    const line = part ? order.lines.find((candidate) => candidate.partId === part.id) : undefined;
    if (!part || !line) {
      toast({
        title: "Barcode is not on this purchase order",
        description: "No outstanding line on this PO matches the scanned part.",
        variant: "destructive",
      });
      return;
    }
    const outstanding = Math.max(0, line.quantity - line.qtyReceived);
    if (outstanding === 0) {
      toast({ title: "Line already fully received", description: part.name });
      return;
    }
    setQuantities((current) => ({ ...current, [line.id]: outstanding }));
    toast({
      title: "Receipt line prefilled",
      description: `${part.name}: ${outstanding} outstanding. Review the quantity and documents before posting.`,
    });
  };

  const submit = async () => {
    if (!order) return;
    if (!deliveryNoteNumber.trim() || !warehouseLocation.trim()) {
      toast({ title: "Receipt details required", description: "Enter the delivery note and receiving location.", variant: "destructive" });
      return;
    }
    if (files.length === 0) {
      toast({ title: "Supporting document required", description: "Attach the supplier delivery note, invoice, packing list, or receiving photo.", variant: "destructive" });
      return;
    }
    const lines = order.lines
      .map((line) => ({ lineId: line.id, qty: quantities[line.id] ?? 0 }))
      .filter((line) => line.qty > 0);
    if (lines.length === 0) {
      toast({ title: "Nothing selected to receive", variant: "destructive" });
      return;
    }
    try {
      const documents = [];
      for (const file of files) {
        const uploaded = await uploadFile(file);
        if (!uploaded) throw new Error(`Could not upload ${file.name}`);
        documents.push({
          objectPath: uploaded.objectPath,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
        });
      }
      await receive.mutateAsync({
        id: order.id,
        data: {
          idempotencyKey: crypto.randomUUID(),
          receivedAt: new Date(receivedAt).toISOString(),
          deliveryNoteNumber: deliveryNoteNumber.trim(),
          ...(supplierInvoiceNumber.trim() ? { supplierInvoiceNumber: supplierInvoiceNumber.trim() } : {}),
          warehouseLocation: warehouseLocation.trim(),
          condition,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          documents,
          lines,
        },
      });
      onSuccess();
      toast({ title: "Shipment received", description: `PO #${order.id} stock and receipt records are updated.` });
      onOpenChange(false);
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error || (error as Error).message;
      toast({ title: "Could not receive shipment", description: message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={order != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl glass-panel border-none">
        <DialogHeader>
          <DialogTitle>Receive Purchase Order #{order?.id}</DialogTitle>
          <DialogDescription>Record exactly what arrived and attach the supplier paperwork before stock is updated.</DialogDescription>
        </DialogHeader>
        {order && (
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-2">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-3">
              <div>
                <div className="text-sm font-medium">Scan a received part</div>
                <div className="text-xs text-muted-foreground">Scanning only prefills its outstanding quantity; it never posts a receipt.</div>
              </div>
              <PartBarcodeScanner onScan={handleBarcode} disabled={receive.isPending} />
            </div>
            <div className="space-y-2">
              {order.lines.map((line) => {
                const outstanding = Math.max(0, line.quantity - line.qtyReceived);
                return (
                  <div key={line.id} className="grid grid-cols-[1fr_120px] gap-4 items-center rounded-xl border border-white/5 bg-white/[0.03] p-3">
                    <div>
                      <div className="text-sm font-medium">{line.partName}</div>
                      <div className="text-xs text-muted-foreground">{outstanding} outstanding</div>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={outstanding}
                      value={quantities[line.id] ?? 0}
                      onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: Number(event.target.value) }))}
                      className="border-white/10 bg-white/[0.03]"
                    />
                  </div>
                );
              })}
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2"><label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Received at</label><Input type="datetime-local" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} /></div>
              <div className="space-y-2"><label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Delivery note number</label><Input value={deliveryNoteNumber} onChange={(event) => setDeliveryNoteNumber(event.target.value)} placeholder="Required" /></div>
              <div className="space-y-2"><label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Supplier invoice number</label><Input value={supplierInvoiceNumber} onChange={(event) => setSupplierInvoiceNumber(event.target.value)} placeholder="Optional" /></div>
              <div className="space-y-2"><label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Receiving location</label><Input value={warehouseLocation} onChange={(event) => setWarehouseLocation(event.target.value)} /></div>
              <div className="space-y-2 sm:col-span-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Shipment condition</label>
                <StyledSelect
                  value={condition}
                  onValueChange={(value) => setCondition(value as typeof condition)}
                  options={[
                    { value: "accepted", label: "Accepted — quantities and condition match" },
                    { value: "accepted_with_discrepancy", label: "Accepted with discrepancy" },
                  ]}
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Supporting documents</label>
              <Input type="file" multiple accept="image/*,.pdf,.docx" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
              <p className="text-xs text-muted-foreground">Attach at least one delivery note, supplier invoice, packing list, or receiving photo.</p>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Receiving notes</label>
              <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Damage, shortages, substitutions, serial or batch details…" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={receive.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={receive.isPending}>
            {receive.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Confirm Receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PurchasesTab() {
  const money = useMoney();
  const { data: purchases, isLoading } = useListPartPurchases();
  const { data: parts } = useListParts();
  const { data: suppliers } = useListSuppliers();

  if (isLoading) return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!purchases?.length)
    return (
      <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
        <ShoppingCart className="w-8 h-8 text-muted-foreground" />
        <p className="text-muted-foreground">No purchases recorded yet.</p>
      </div>
    );

  const partName = (id: number) => parts?.find((p) => p.id === id)?.name ?? `Part #${id}`;
  const supplierName = (id: number | null | undefined) =>
    id == null ? "—" : suppliers?.find((s) => s.id === id)?.name ?? `Supplier #${id}`;

  return (
    <div className="grid grid-cols-1 gap-3">
      {purchases.map((p) => (
        <Card key={p.id} className="glass-panel border-none rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">{partName(p.partId)}</div>
              <div className="text-sm text-muted-foreground">
                {supplierName(p.supplierId)}
                {p.reference && ` · ${p.reference}`} ·{" "}
                {formatGuyanaDate(p.createdAt)}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="font-light text-xl">
                  {p.status === "ordered" ? `${p.qtyReceived ?? 0}/${p.quantity}` : `+${p.quantity}`}
                </div>
                <div className="text-sm text-muted-foreground">
                  @ {money.gyd(p.unitCost)}
                </div>
              </div>
              <Badge
                className={cn(
                  "border-none rounded-full text-[10px] font-bold uppercase tracking-widest",
                  p.status === "received"
                    ? "bg-primary/15 text-primary"
                    : "bg-white/[0.08] text-muted-foreground",
                )}
              >
                {p.status ?? "received"}
              </Badge>
              {p.status === "ordered" && (
                <ReceivePurchaseDialog
                  purchaseId={p.id}
                  outstanding={p.quantity - (p.qtyReceived ?? 0)}
                />
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
