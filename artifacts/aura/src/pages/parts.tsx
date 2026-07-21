import { useState } from "react";
import {
  useListParts,
  useCreatePart,
  getListPartsQueryKey,
  useListSuppliers,
  useCreateSupplier,
  getListSuppliersQueryKey,
  useListPartPurchases,
  useCreatePartPurchase,
  getListPartPurchasesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Package,
  Truck,
  ShoppingCart,
  AlertTriangle,
  Search,
} from "lucide-react";
import { format } from "date-fns";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useMoney } from "@/lib/format";

const TABS = [
  { key: "parts", label: "Parts", icon: Package },
  { key: "suppliers", label: "Suppliers", icon: Truck },
  { key: "purchases", label: "Purchases", icon: ShoppingCart },
] as const;
type TabKey = (typeof TABS)[number]["key"];

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
        { name: "sku", label: "SKU", type: "text", required: true, span: "half", placeholder: "BRK-PAD-BMW-X5" },
        { name: "name", label: "Name", type: "text", required: true, span: "half", placeholder: "Front brake pad set" },
        { name: "category", label: "Category", type: "text", span: "half", placeholder: "Brakes" },
        {
          name: "supplierId",
          label: "Supplier",
          type: "select",
          span: "half",
          options: suppliers?.map((s) => ({ value: String(s.id), label: s.name })) ?? [],
        },
        { name: "unitCost", label: "Unit cost", type: "number", span: "half", placeholder: "85" },
        { name: "unitPrice", label: "Unit price", type: "number", span: "half", placeholder: "140" },
        { name: "stock", label: "Opening stock", type: "number", span: "half", placeholder: "10" },
        { name: "reorderLevel", label: "Reorder level", type: "number", span: "half", placeholder: "3" },
        { name: "location", label: "Bin location", type: "text", span: "full", placeholder: "A-04" },
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

function PartsTab() {
  const money = useMoney();
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const { data: parts, isLoading } = useListParts({
    ...(search ? { search } : {}),
    ...(lowOnly ? { lowStock: "1" } : {}),
  });

  const lowCount = parts?.filter((p) => p.stock <= p.reorderLevel).length ?? 0;
  const { density, setDensity, layout, setLayout } = useViewMode("parts");

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or SKU..."
            className="pl-10 rounded-full bg-white/[0.03] border-white/10"
          />
        </div>
        <Button
          variant={lowOnly ? "default" : "outline"}
          onClick={() => setLowOnly((v) => !v)}
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
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => {
                const low = p.stock <= p.reorderLevel;
                return (
                  <tr key={p.id} className="border-b border-white/5 hover:bg-foreground/[0.03] transition-colors">
                    <td className={cn("px-4 font-medium", density === "compact" ? "py-2.5" : "py-3.5")}>
                      {p.name}
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
                      <div className="text-xs text-muted-foreground mt-0.5">{p.category}</div>
                    </div>
                    {low && (
                      <Badge className="bg-primary/15 text-primary border-none rounded-full text-[10px] font-bold uppercase tracking-widest gap-1 shrink-0">
                        <AlertTriangle className="w-3 h-3" /> Reorder
                      </Badge>
                    )}
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
        { name: "name", label: "Company", type: "text", required: true, span: "full", placeholder: "Bosch Ghana Ltd" },
        { name: "contactName", label: "Contact", type: "text", span: "half" },
        { name: "email", label: "Email", type: "text", span: "half" },
        { name: "phone", label: "Phone", type: "text", span: "half" },
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
                {format(new Date(p.createdAt), "MMM d, yyyy")}
              </div>
            </div>
            <div className="text-right">
              <div className="font-light text-xl">+{p.quantity}</div>
              <div className="text-sm text-muted-foreground">
                @ {money.gyd(p.unitCost)}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
