import { useEffect, useState } from "react";
import {
  useListParts,
  useCreatePart,
  useUpdatePart,
  type Part,
  getListPartsQueryKey,
  useListSuppliers,
  useCreateSupplier,
  getListSuppliersQueryKey,
  useListPartPurchases,
  useCreatePartPurchase,
  useReceivePartPurchase,
  getListPartPurchasesQueryKey,
  useGetPartsSettings,
  useUpdatePartsSettings,
  getGetPartsSettingsQueryKey,
  useListPurchaseOrders,
  useCreatePurchaseOrder,
  useUpdatePurchaseOrder,
  useReceivePurchaseOrder,
  getListPurchaseOrdersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";
import { useAuthz } from "@/lib/auth";
import { ImportPartsDialog } from "@/components/parts/import-parts-dialog";

import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatGuyanaDate, useMoney } from "@/lib/format";

const TABS = [
  { key: "parts", label: "Parts", icon: Package },
  { key: "suppliers", label: "Suppliers", icon: Truck },
  { key: "orders", label: "Purchase Orders", icon: ClipboardList },
  { key: "purchases", label: "Quick Purchases", icon: ShoppingCart },
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

export default function Parts() {
  const [tab, setTab] = useState<TabKey>("parts");

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
        ) : tab === "suppliers" ? (
          <CreateSupplierDialog />
        ) : tab === "orders" ? (
          <CreatePurchaseOrderDialog />
        ) : (
          <CreatePurchaseDialog />
        )
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
          {tab === "suppliers" && <SuppliersTab />}
          {tab === "orders" && <PurchaseOrdersTab />}
          {tab === "purchases" && <PurchasesTab />}
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
        { name: "name", label: "Part name", type: "text", required: true, span: "half", placeholder: "Engine oil filter" },
        { name: "category", label: "Category / make", type: "text", span: "half", placeholder: "BYD" },
        {
          name: "supplierId",
          label: "Supplier",
          type: "select",
          span: "half",
          options: suppliers?.map((s) => ({ value: String(s.id), label: s.name })) ?? [],
        },
        { name: "unitCost", label: "Unit cost (GYD)", type: "number", span: "half", placeholder: "53908.78" },
        { name: "unitPrice", label: "Selling price (GYD)", type: "number", span: "half", placeholder: "80863.17" },
        { name: "stock", label: "Quantity in stock", type: "number", span: "half", placeholder: "10" },
        { name: "reorderLevel", label: "Reorder level", type: "number", span: "half", placeholder: "3" },
        { name: "location", label: "Location", type: "text", span: "full", placeholder: "Container 1 353439" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        await create.mutateAsync({
          data: {
            sku: String(v.sku),
            name: String(v.name),
            ...(v.category ? { category: String(v.category) } : {}),
            ...(v.supplierId ? { supplierId: Number(v.supplierId) } : {}),
            ...(v.unitCost ? { unitCost: Number(v.unitCost) } : {}),
            ...(v.unitPrice ? { unitPrice: Number(v.unitPrice) } : {}),
            ...(v.stock ? { stock: Number(v.stock) } : {}),
            ...(v.reorderLevel ? { reorderLevel: Number(v.reorderLevel) } : {}),
            ...(v.location ? { location: String(v.location) } : {}),
          },
        });
        queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
        toast({ title: "Part added" });
      }}
    />
  );
}

function EditPartDialog({ part }: { part: Part }) {
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
        { name: "name", label: "Part name", type: "text", required: true, span: "half", defaultValue: part.name },
        { name: "category", label: "Category / make", type: "text", span: "half", defaultValue: part.category ?? "" },
        {
          name: "supplierId",
          label: "Supplier",
          type: "select",
          span: "half",
          defaultValue: part.supplierId ? String(part.supplierId) : "",
          options: suppliers?.map((s) => ({ value: String(s.id), label: s.name })) ?? [],
        },
        { name: "unitCost", label: "Unit cost (GYD)", type: "number", span: "half", defaultValue: String(part.unitCost ?? 0) },
        { name: "unitPrice", label: "Selling price (GYD)", type: "number", span: "half", defaultValue: String(part.unitPrice ?? 0) },
        { name: "stock", label: "Quantity in stock", type: "number", span: "half", defaultValue: String(part.stock ?? 0) },
        { name: "reorderLevel", label: "Reorder level", type: "number", span: "half", defaultValue: String(part.reorderLevel ?? 5) },
        { name: "location", label: "Location", type: "text", span: "full", defaultValue: part.location ?? "" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        await update.mutateAsync({
          id: part.id,
          data: {
            sku: String(v.sku),
            name: String(v.name),
            ...(v.category !== undefined && v.category !== "" ? { category: String(v.category) } : {}),
            ...(v.supplierId ? { supplierId: Number(v.supplierId) } : {}),
            unitCost: v.unitCost === "" ? 0 : Number(v.unitCost),
            unitPrice: v.unitPrice === "" ? 0 : Number(v.unitPrice),
            stock: v.stock === "" ? 0 : Number(v.stock),
            reorderLevel: v.reorderLevel === "" ? 5 : Number(v.reorderLevel),
            ...(v.location !== undefined && v.location !== "" ? { location: String(v.location) } : {}),
          },
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
                <th className="px-4 py-3 font-semibold hidden md:table-cell">SKU</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Category</th>
                <th className="px-4 py-3 font-semibold text-right">Stock</th>
                <th className="px-4 py-3 font-semibold text-right hidden md:table-cell">Cost</th>
                <th className="px-4 py-3 font-semibold text-right">Price</th>
                <th className="px-4 py-3 font-semibold text-right w-12" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => {
                const low = p.stock <= p.reorderLevel;
                return (
                  <tr key={p.id} className="border-b border-white/5 hover:bg-foreground/[0.03] transition-colors">
                    <td className={cn("px-4 font-medium", density === "compact" ? "py-2.5" : "py-3.5")}>
                      {p.name}
                      {p.status && p.status !== "active" && (
                        <span className="ml-2 rounded-full bg-white/[0.08] text-muted-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                          {p.status}
                        </span>
                      )}
                      {low && (
                        <span className="ml-2 rounded-full bg-primary/15 text-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                          Reorder
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden md:table-cell">{p.sku}</td>
                    <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">{p.category}</td>
                    <td className={cn("px-4 py-2 text-right tabular-nums font-semibold", low && "text-primary")}>
                      {p.stock} <span className="text-muted-foreground font-normal">/ {p.reorderLevel}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums hidden md:table-cell">
                      {money.gyd(p.unitCost)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {money.gyd(p.unitPrice)}
                    </td>
                    <td className="px-2 py-2 text-right">
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
          {parts.map((p) => {
            const low = p.stock <= p.reorderLevel;
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
                        {p.location && ` · Bin ${p.location}`}
                      </div>
                      <h3 className="font-bold leading-tight">{p.name}</h3>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {p.category}
                        {p.status && p.status !== "active" && (
                          <span className="ml-2 rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                            {p.status}
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
                      <EditPartDialog part={p} />
                    </div>
                  </div>
                  <div className="flex items-end justify-between">
                    <div>
                      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-0.5">
                        In stock
                      </div>
                      <div
                        className={cn(
                          "font-light text-2xl tracking-tight",
                          low && "text-primary",
                        )}
                      >
                        {p.stock}
                        <span className="text-sm text-muted-foreground"> / min {p.reorderLevel}</span>
                      </div>
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
  const { data: suppliers, isLoading } = useListSuppliers();
  if (isLoading) return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!suppliers?.length)
    return (
      <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
        <Truck className="w-8 h-8 text-muted-foreground" />
        <p className="text-muted-foreground">No suppliers registered yet.</p>
      </div>
    );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {suppliers.map((s) => (
        <Card key={s.id} className="glass-panel border-none rounded-3xl">
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
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
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
  const create = useCreatePurchaseOrder();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<string>("");
  const [expectedDate, setExpectedDate] = useState("");
  const [reference, setReference] = useState("");
  const [placeNow, setPlaceNow] = useState(true);
  const [lines, setLines] = useState<{ partId: string; quantity: string; unitCost: string }[]>([
    { partId: "", quantity: "1", unitCost: "" },
  ]);

  const reset = () => {
    setSupplierId("");
    setExpectedDate("");
    setReference("");
    setPlaceNow(true);
    setLines([{ partId: "", quantity: "1", unitCost: "" }]);
  };

  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    const parsedLines = lines
      .filter((l) => l.partId)
      .map((l) => ({
        partId: Number(l.partId),
        quantity: Math.max(1, Math.floor(Number(l.quantity) || 1)),
        ...(l.unitCost !== "" && Number.isFinite(Number(l.unitCost))
          ? { unitCost: Number(l.unitCost) }
          : {}),
      }));
    if (parsedLines.length === 0) {
      toast({ title: "Add at least one part line", variant: "destructive" });
      return;
    }
    try {
      await create.mutateAsync({
        data: {
          ...(supplierId ? { supplierId: Number(supplierId) } : {}),
          ...(expectedDate ? { expectedDate } : {}),
          ...(reference ? { reference } : {}),
          status: placeNow ? "ordered" : "draft",
          lines: parsedLines,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
      toast({
        title: placeNow ? "Purchase order placed" : "Draft PO saved",
        description: `${parsedLines.length} line${parsedLines.length === 1 ? "" : "s"}.`,
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
      <DialogContent className="glass-panel border-white/10 sm:max-w-[640px]">
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
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full h-10 rounded-xl bg-white/[0.04] border border-white/10 px-3 text-sm"
            >
              <option value="">— None —</option>
              {suppliers?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
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
          <div className="grid grid-cols-[1fr_84px_110px_36px] gap-2 text-[11px] uppercase tracking-widest text-muted-foreground px-1">
            <span>Part</span>
            <span>Qty</span>
            <span>Unit cost</span>
            <span />
          </div>
          {lines.map((line, i) => (
            <div key={i} className="grid grid-cols-[1fr_84px_110px_36px] gap-2">
              <select
                value={line.partId}
                onChange={(e) => {
                  const part = parts?.find((p) => p.id === Number(e.target.value));
                  setLine(i, {
                    partId: e.target.value,
                    unitCost: part ? String(part.unitCost) : line.unitCost,
                  });
                }}
                className="h-10 rounded-xl bg-white/[0.04] border border-white/10 px-3 text-sm min-w-0"
              >
                <option value="">Select part…</option>
                {parts?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                  </option>
                ))}
              </select>
              <Input
                type="number"
                min={1}
                value={line.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
                className="h-10 rounded-xl bg-white/[0.04] border-white/10 text-right"
              />
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
          ))}
          <Button
            variant="outline"
            className="rounded-full gap-2 border-white/15 h-9"
            onClick={() => setLines((prev) => [...prev, { partId: "", quantity: "1", unitCost: "" }])}
          >
            <Plus className="w-4 h-4" />
            Add line
          </Button>
        </div>
        <DialogFooter className="items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground mr-auto cursor-pointer">
            <input
              type="checkbox"
              checked={placeNow}
              onChange={(e) => setPlaceNow(e.target.checked)}
              className="accent-primary"
            />
            Place order now (uncheck to save as draft)
          </label>
          <Button
            onClick={submit}
            disabled={create.isPending}
            className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
          >
            {create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {placeNow ? "Place order" : "Save draft"}
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
  const receive = useReceivePurchaseOrder();
  const [busyId, setBusyId] = useState<number | null>(null);

  const supplierName = (id: number | null | undefined) =>
    id == null ? "No supplier" : (suppliers?.find((s) => s.id === id)?.name ?? `Supplier #${id}`);

  const act = async (id: number, fn: () => Promise<unknown>, done: string) => {
    setBusyId(id);
    try {
      await fn();
      queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
      toast({ title: done });
    } catch (err) {
      toast({
        title: "Action failed",
        description: err instanceof Error ? err.message : undefined,
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
                      onClick={() =>
                        act(
                          po.id,
                          () => receive.mutateAsync({ id: po.id, data: {} }),
                          `Received ${outstanding} unit(s) into stock`,
                        )
                      }
                      className="bg-primary hover:bg-primary/90 text-white rounded-full px-5"
                    >
                      Receive all ({outstanding})
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
    </div>
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
