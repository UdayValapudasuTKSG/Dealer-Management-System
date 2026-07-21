import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useMoney } from "@/lib/format";

export type CascadeVehicle = {
  id: number;
  brand: string;
  model: string;
  version: string;
  color: string;
  year: number;
  vin: string | null;
  price: number;
};

const STEP_ORDER = ["brand", "model", "version", "color", "unit"] as const;
type Step = (typeof STEP_ORDER)[number];

const uniq = (arr: string[]) =>
  [...new Set(arr)].sort((a, b) => a.localeCompare(b));

export function VehicleCascade({
  vehicles,
  loading,
  onResolve,
  showSummary = true,
  unitSelection = true,
}: {
  vehicles: CascadeVehicle[];
  loading?: boolean;
  onResolve: (vehicle: CascadeVehicle | null) => void;
  showSummary?: boolean;
  /**
   * When false (DMS-spec lead capture): the cascade stops at model level —
   * no per-unit picker, no VIN shown. The first matching unit is resolved
   * internally only to link a model of interest; the actual VIN is bound
   * later at the Vehicle Allocated stage.
   */
  unitSelection?: boolean;
}) {
  const money = useMoney();
  const [sel, setSel] = useState<Record<Step, string>>({
    brand: "",
    model: "",
    version: "",
    color: "",
    unit: "",
  });

  const setStep = (step: Step) => (value: string) =>
    setSel((s) => {
      const next = { ...s, [step]: value };
      for (const k of STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1)) {
        next[k] = "";
      }
      return next;
    });

  const brands = useMemo(() => uniq(vehicles.map((v) => v.brand)), [vehicles]);
  const byBrand = useMemo(
    () => vehicles.filter((v) => v.brand === sel.brand),
    [vehicles, sel.brand],
  );
  const models = useMemo(() => uniq(byBrand.map((v) => v.model)), [byBrand]);
  const byModel = useMemo(
    () => byBrand.filter((v) => v.model === sel.model),
    [byBrand, sel.model],
  );
  const versions = useMemo(() => uniq(byModel.map((v) => v.version)), [byModel]);
  const byVersion = useMemo(
    () => byModel.filter((v) => v.version === sel.version),
    [byModel, sel.version],
  );
  const colors = useMemo(() => uniq(byVersion.map((v) => v.color)), [byVersion]);
  const candidates = useMemo(
    () => byVersion.filter((v) => v.color === sel.color),
    [byVersion, sel.color],
  );

  // Auto-select a step when it has exactly one possible option.
  useEffect(() => {
    if (!sel.brand && brands.length === 1) setStep("brand")(brands[0]);
    else if (sel.brand && !sel.model && models.length === 1)
      setStep("model")(models[0]);
    else if (sel.model && !sel.version && versions.length === 1)
      setStep("version")(versions[0]);
    else if (sel.version && !sel.color && colors.length === 1)
      setStep("color")(colors[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, brands, models, versions, colors]);

  const resolved =
    sel.color === ""
      ? null
      : !unitSelection || candidates.length === 1
        ? (candidates[0] ?? null)
        : (candidates.find((v) => String(v.id) === sel.unit) ?? null);

  const resolvedId = resolved?.id ?? null;
  useEffect(() => {
    onResolve(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedId]);

  const stepSelect = (
    step: Step,
    label: string,
    options: string[],
    disabled: boolean,
    placeholder: string,
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Select
        value={sel[step]}
        onValueChange={setStep(step)}
        disabled={disabled}
      >
        <SelectTrigger className="bg-white/[0.04] border-white/10">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        {stepSelect(
          "brand",
          "Brand",
          brands,
          !!loading || brands.length === 0,
          loading ? "Loading inventory…" : "Select brand",
        )}
        {stepSelect("model", "Model", models, !sel.brand, "Select model")}
        {stepSelect(
          "version",
          "Version / Trim",
          versions,
          !sel.model,
          "Select version",
        )}
        {stepSelect("color", "Color", colors, !sel.version, "Select color")}
      </div>
      {unitSelection && sel.color !== "" && candidates.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Specific unit
          </Label>
          <Select value={sel.unit} onValueChange={setStep("unit")}>
            <SelectTrigger className="bg-white/[0.04] border-white/10">
              <SelectValue placeholder="Multiple units match — pick one" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((v) => (
                <SelectItem key={v.id} value={String(v.id)}>
                  {v.year} · {v.vin ? `VIN ${v.vin}` : `Unit #${v.id}`} ·{" "}
                  {money.gyd(v.price)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {showSummary && resolved && (
        <div className="grid grid-cols-3 gap-x-4 gap-y-2 rounded-xl border border-primary/20 bg-primary/5 p-3.5 text-sm">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Year
            </div>
            <div className="font-medium">{resolved.year}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {unitSelection ? "VIN" : "Unit & VIN"}
            </div>
            <div className="font-medium">
              {unitSelection
                ? (resolved.vin ?? "On request")
                : "Assigned at allocation"}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Price
            </div>
            <div className="font-medium">
              {money.gyd(resolved.price)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
