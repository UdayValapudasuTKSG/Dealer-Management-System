import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWorkshopOils, useCreateWorkshopOil, useUpdateWorkshopOil,
  getListWorkshopOilsQueryKey, type WorkshopOil,
} from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const blank = { name: "", grade: "", specification: "", brand: "",
  purchaseCostPerLitre: 0, sellingPricePerLitre: 0, stockLitres: 0, reorderLitres: 0, active: true };
type Draft = typeof blank;
const apiErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
const fields: { key: keyof Draft; label: string; step?: string }[] = [
  { key: "name", label: "Oil name" }, { key: "brand", label: "Brand" },
  { key: "grade", label: "Grade / viscosity" }, { key: "specification", label: "Specification" },
  { key: "purchaseCostPerLitre", label: "Purchase cost / L (GYD)", step: "0.01" },
  { key: "sellingPricePerLitre", label: "Selling price / L (GYD)", step: "0.01" },
  { key: "stockLitres", label: "Stock (L)", step: "0.001" },
  { key: "reorderLitres", label: "Reorder threshold (L)", step: "0.001" },
];

export function OilCatalog() {
  const { can } = useAuthz();
  const { toast } = useToast();
  const client = useQueryClient();
  const { data: oils, isLoading, error } = useListWorkshopOils();
  const create = useCreateWorkshopOil();
  const update = useUpdateWorkshopOil();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const edit = (oil?: WorkshopOil) => {
    setEditing(oil?.id ?? "new");
    setDraft(oil ? { name: oil.name, brand: oil.brand, grade: oil.grade,
      specification: oil.specification, purchaseCostPerLitre: oil.purchaseCostPerLitre,
      sellingPricePerLitre: oil.sellingPricePerLitre, stockLitres: oil.stockLitres,
      reorderLitres: oil.reorderLitres, active: oil.active } : { ...blank });
  };
  const save = async () => {
    setBusy(true);
    try {
      if (editing === "new") await create.mutateAsync({ data: draft });
      else if (editing !== null) await update.mutateAsync({ id: editing, data: draft });
      await client.invalidateQueries({ queryKey: getListWorkshopOilsQueryKey() });
      setEditing(null);
      toast({ title: "Oil saved" });
    } catch (err) {
      toast({ title: "Could not save oil", description: apiErrorMessage(err, "Try again."), variant: "destructive" });
    } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <div className="flex items-center justify-between">
      <p className="text-sm text-muted-foreground">Oil stock and prices are in litres · GYD.</p>
      {can("parts", "create") && <Button onClick={() => edit()}>Add oil</Button>}
    </div>
    {editing !== null && <Card><CardContent className="p-5 space-y-4">
      <h3 className="font-semibold">{editing === "new" ? "New oil" : "Edit oil"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(({ key, label, step }) => <label key={key} className="text-xs text-muted-foreground space-y-1">
          <span>{label}</span><Input type={step ? "number" : "text"} step={step} min={step ? 0 : undefined}
            value={draft[key] as string | number}
            onChange={e => setDraft(d => ({ ...d, [key]: step ? Number(e.target.value) : e.target.value }))} />
        </label>)}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.active}
        onChange={e => setDraft(d => ({ ...d, active: e.target.checked }))} /> Active</label>
      <div className="flex gap-2"><Button disabled={busy || !draft.name.trim()} onClick={save}>Save oil</Button>
        <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button></div>
    </CardContent></Card>}
    {isLoading && <p className="text-sm">Loading oils…</p>}
    {error && <p className="text-sm text-destructive">{apiErrorMessage(error, "Unable to load oils.")}</p>}
    {!isLoading && !error && !oils?.length && <p className="text-sm text-muted-foreground">No oils in this dealership yet.</p>}
    <div className="grid gap-3 md:grid-cols-2">
      {oils?.map(oil => <Card key={oil.id}><CardContent className="p-5 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div><h3 className="font-semibold">{oil.name} {!oil.active && <span className="text-xs text-muted-foreground">(inactive)</span>}</h3>
            <p className="text-xs text-muted-foreground">{[oil.brand, oil.grade, oil.specification].filter(Boolean).join(" · ")}</p></div>
          {can("parts", "edit") && <Button variant="outline" size="sm" onClick={() => edit(oil)}>Edit</Button>}
        </div>
        <p className="text-sm">{oil.stockLitres.toFixed(3)} L on hand · Reorder at {oil.reorderLitres.toFixed(3)} L</p>
        <p className="text-xs text-muted-foreground">Purchase GYD {oil.purchaseCostPerLitre.toFixed(2)}/L · Sell GYD {oil.sellingPricePerLitre.toFixed(2)}/L</p>
      </CardContent></Card>)}
    </div>
  </div>;
}