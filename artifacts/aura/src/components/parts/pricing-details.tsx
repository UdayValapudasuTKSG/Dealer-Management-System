import type { Part, PartPricingDetails } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReceiptText, Trash2 } from "lucide-react";
import { useMoney } from "@/lib/format";

type PricingDetails = NonNullable<PartPricingDetails>;
type PricingKey = keyof PricingDetails;
type PricingDraft = Record<PricingKey, string>;

const fields: {
  key: PricingKey;
  label: string;
  percent?: boolean;
  integer?: boolean;
}[] = [
  { key: "quantity", label: "Source QTY", integer: true },
  { key: "unitCostUsd", label: "Unit cost (USD)" },
  { key: "totalUsd", label: "Total (USD)" },
  { key: "cifUsd", label: "CIF (USD)" },
  { key: "dutyRate", label: "Duty (%)", percent: true },
  { key: "vatRate", label: "VAT (%)", percent: true },
  { key: "dutyGyd", label: "Duty (GYD)" },
  { key: "vatGyd", label: "VAT (GYD)" },
  { key: "landedCostGyd", label: "Landed cost (GYD)" },
  { key: "sellingVatGyd", label: "Selling VAT (GYD)" },
  { key: "finalSellingPriceGyd", label: "Final SP (GYD)" },
];

export function pricingDetailsToDraft(details?: PartPricingDetails): string {
  if (!details) return "{}";
  return JSON.stringify(
    Object.fromEntries(
      fields.flatMap(({ key, percent }) => {
        const value = details[key];
        return value == null ? [] : [[key, String(percent ? value * 100 : value)]];
      }),
    ),
  );
}

export function pricingDetailsDraftError(raw: string): string | null {
  if (raw === "null") return null;
  try {
    const draft = JSON.parse(raw) as Partial<PricingDraft>;
    for (const { key, label, percent, integer } of fields) {
      const value = draft[key];
      if (value == null || value === "") continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return `${label} must be zero or more`;
      if (percent && number > 100) return `${label} must be between 0 and 100`;
      if (integer && !Number.isInteger(number)) return `${label} must be a whole number`;
    }
    return null;
  } catch {
    return "Pricing details are invalid";
  }
}

export function pricingDetailsFromDraft(raw: unknown): PartPricingDetails | null | undefined {
  if (raw == null || raw === "") return undefined;
  if (raw === "null") return null;
  const draft = JSON.parse(String(raw)) as Partial<PricingDraft>;
  const details: PricingDetails = {};
  for (const { key, percent } of fields) {
    const value = draft[key];
    if (value == null || value === "") continue;
    details[key] = percent ? Number(value) / 100 : Number(value);
  }
  return Object.keys(details).length ? details : undefined;
}

export function PricingDetailsEditor({
  value,
  onChange,
  allowClear = false,
}: {
  value: string;
  onChange: (value: string) => void;
  allowClear?: boolean;
}) {
  const cleared = value === "null";
  const draft = cleared ? {} : (JSON.parse(value || "{}") as Partial<PricingDraft>);
  const setField = (key: PricingKey, next: string) =>
    onChange(JSON.stringify({ ...draft, [key]: next }));

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          USD amounts are references only. Rates are entered as percentages and saved as fractions.
        </p>
        {allowClear && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 text-[11px] text-muted-foreground"
            onClick={() => onChange(cleared ? "{}" : "null")}
          >
            <Trash2 className="h-3 w-3" />
            {cleared ? "Restore fields" : "Clear all"}
          </Button>
        )}
      </div>
      {cleared ? (
        <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-muted-foreground">
          All saved worksheet pricing metadata will be cleared.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {fields.map(({ key, label, percent, integer }) => (
            <div key={key} className="space-y-1">
              <Label className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</Label>
              <Input
                type="number"
                min={0}
                max={percent ? 100 : undefined}
                step={integer ? 1 : "any"}
                inputMode="decimal"
                value={draft[key] ?? ""}
                onChange={(event) => setField(key, event.target.value)}
                className="h-8 bg-white/[0.04] text-xs"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const displayFields: { key: PricingKey; label: string; currency?: "USD" | "GYD"; rate?: boolean }[] = [
  { key: "quantity", label: "QTY (source)" },
  { key: "unitCostUsd", label: "Unit cost", currency: "USD" },
  { key: "totalUsd", label: "Total", currency: "USD" },
  { key: "cifUsd", label: "CIF", currency: "USD" },
  { key: "dutyRate", label: "Duty rate", rate: true },
  { key: "vatRate", label: "VAT rate", rate: true },
  { key: "dutyGyd", label: "Duty", currency: "GYD" },
  { key: "vatGyd", label: "VAT", currency: "GYD" },
  { key: "landedCostGyd", label: "Landed cost", currency: "GYD" },
  { key: "sellingVatGyd", label: "Selling VAT", currency: "GYD" },
  { key: "finalSellingPriceGyd", label: "Final selling price", currency: "GYD" },
];

export function PricingBreakdownDialog({ part }: { part: Part }) {
  const money = useMoney();
  const details = part.pricingDetails;
  const render = (value: number, currency?: "USD" | "GYD", rate?: boolean) => {
    if (rate) return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
    if (currency === "GYD") return money.gyd(value);
    if (currency === "USD") return `USD ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return value.toLocaleString();
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground" aria-label={`View pricing breakdown for ${part.name}`}>
          <ReceiptText className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>{part.name} · Pricing breakdown</DialogTitle>
          <DialogDescription>
            {part.sku} · Current stock {part.stock}. Worksheet QTY is shown separately and does not represent current availability.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Unit cost (GYD)</p>
            <p className="mt-1 font-semibold tabular-nums">{money.gyd(part.unitCost)}</p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Unit SP pre-VAT (GYD)</p>
            <p className="mt-1 font-semibold tabular-nums">{money.gyd(part.unitPrice)}</p>
          </div>
          {displayFields.map(({ key, label, currency, rate }) => {
            const value = details?.[key];
            return (
              <div key={key} className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}{currency ? ` (${currency})` : ""}</p>
                <p className="mt-1 font-medium tabular-nums">{value == null ? "Not recorded" : render(value, currency, rate)}</p>
              </div>
            );
          })}
        </div>
        {!details && (
          <p className="text-xs text-muted-foreground">This older part has no saved worksheet pricing metadata.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}