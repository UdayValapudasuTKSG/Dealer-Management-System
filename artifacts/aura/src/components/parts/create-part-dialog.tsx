import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListPartsQueryKey, useCreatePart, useListPartsBins, useListPartsLocations,
  useListSuppliers, type PartInput,
} from "@workspace/api-client-react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { PricingDetailsEditor, pricingDetailsDraftError, pricingDetailsFromDraft } from "./pricing-details";

export function CreatePartDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreatePart();
  const { data: suppliers } = useListSuppliers();
  const { data: locations } = useListPartsLocations();
  const { data: bins } = useListPartsBins();
  const [locationId, setLocationId] = useState("");
  const activeLocations = useMemo(() => locations?.filter(l => l.active) ?? [], [locations]);
  const availableBins = bins?.filter(b => b.active && String(b.locationId) === locationId) ?? [];
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
        { name: "supplierId", label: "Supplier", type: "select", span: "half",
          options: suppliers?.map(s => ({ value: String(s.id), label: s.name })) ?? [] },
        { name: "costingMethod", label: "Costing Method", type: "select", span: "half", defaultValue: "average",
          options: [{ value: "average", label: "Average" }, { value: "fifo", label: "FIFO" }, { value: "landed", label: "Landed" }] },
        { name: "unitCost", label: "Unit cost (GYD)", type: "number", span: "half", placeholder: "53908.78" },
        { name: "unitPrice", label: "Selling price pre-VAT (GYD)", type: "number", span: "half", placeholder: "80863.17" },
        { name: "stock", label: "Current stock", type: "number", span: "half", min: 0, placeholder: "0" },
        { name: "locationId", label: "Location", type: "select", span: "half", required: true,
          options: activeLocations.map(l => ({ value: String(l.id), label: l.name })),
          onChange: (value, _autofill, setField) => { setLocationId(value); setField("binId", ""); } },
        { name: "binId", label: "Bin", type: "select", span: "half", required: true,
          options: availableBins.map(b => ({ value: String(b.id), label: String(b.code) })),
          validate: value => availableBins.some(b => String(b.id) === value) ? null : "Select a bin at this location" },
        { name: "reorderLevel", label: "Reorder Min", type: "number", span: "half", placeholder: "3" },
        { name: "reorderMax", label: "Reorder Max", type: "number", span: "half", placeholder: "10" },
        { name: "active", label: "Status", type: "select", span: "half", defaultValue: "true",
          options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] },
        { name: "pricingDetailsDraft", label: "Worksheet pricing details", type: "custom", span: "full",
          section: "Reference pricing", defaultValue: "{}", validate: pricingDetailsDraftError,
          render: (value, set) => <PricingDetailsEditor value={value} onChange={set} /> },
      ]}
      onSubmit={async values => {
        const v = values as Record<string, unknown>;
        const pricingDetails = pricingDetailsFromDraft(v.pricingDetailsDraft);
        const costingMethod = v.costingMethod === "fifo" ? "fifo" : v.costingMethod === "landed" ? "landed" : "average";
        const data: PartInput = {
          sku: String(v.sku), name: String(v.name),
          locationId: Number(v.locationId), binId: Number(v.binId),
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
        await create.mutateAsync({ data });
        queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
        toast({ title: "Part added" });
      }}
    />
  );
}