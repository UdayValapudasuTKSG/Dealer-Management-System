import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDealerTaxes,
  useCreateDealerTax,
  useUpdateDealerTax,
  useDeleteDealerTax,
  getListDealerTaxesQueryKey,
  useGetServiceSettings,
  useUpdateServiceSettings,
  getGetServiceSettingsQueryKey,
  type DealerTaxRule,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Percent, Plus, Trash2, Wrench } from "lucide-react";

type TaxForm = {
  name: string;
  kind: "percent" | "fixed";
  rate: string;
  thresholdAmount: string;
  effectiveFrom: string;
  notes: string;
};

const EMPTY_FORM: TaxForm = {
  name: "",
  kind: "percent",
  rate: "",
  thresholdAmount: "",
  effectiveFrom: "",
  notes: "",
};

export default function SettingsTaxes() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: taxes, isLoading } = useListDealerTaxes();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DealerTaxRule | null>(null);
  const [form, setForm] = useState<TaxForm>(EMPTY_FORM);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListDealerTaxesQueryKey() });

  const onError = (err: unknown) =>
    toast({
      title: "Request failed",
      description: err instanceof Error ? err.message : String(err),
      variant: "destructive",
    });

  const createTax = useCreateDealerTax({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDialogOpen(false);
        toast({ title: "Tax rule added" });
      },
      onError,
    },
  });
  const updateTax = useUpdateDealerTax({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDialogOpen(false);
        toast({ title: "Tax rule updated" });
      },
      onError,
    },
  });
  const deleteTax = useDeleteDealerTax({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Tax rule removed" });
      },
      onError,
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (t: DealerTaxRule) => {
    setEditing(t);
    setForm({
      name: t.name,
      kind: t.kind,
      rate: String(t.rate),
      thresholdAmount: t.thresholdAmount != null ? String(t.thresholdAmount) : "",
      effectiveFrom: t.effectiveFrom?.slice(0, 10) ?? "",
      notes: t.notes ?? "",
    });
    setDialogOpen(true);
  };

  const submit = () => {
    const base = {
      name: form.name.trim(),
      kind: form.kind,
      rate: Number(form.rate),
      thresholdAmount: form.thresholdAmount.trim()
        ? Number(form.thresholdAmount)
        : null,
      ...(form.effectiveFrom ? { effectiveFrom: form.effectiveFrom } : {}),
      notes: form.notes.trim() ? form.notes.trim() : null,
    };
    if (editing) updateTax.mutate({ id: editing.id, data: base });
    else createTax.mutate({ data: base });
  };

  const pending = createTax.isPending || updateTax.isPending;
  const valid = form.name.trim() && form.rate.trim() && !Number.isNaN(Number(form.rate));

  return (
    <>
    <PageHero
      eyebrow="Settings"
      icon={Percent}
      title="Tax"
      accent="Configuration"
      subtitle="Percentage or fixed tax rules, applied in order, with optional price thresholds. All amounts in GYD."
      action={
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> New Tax Rule
        </Button>
      }
    />
    <SettingsTabs />
    <div className="w-full px-5 md:px-8 pb-8 space-y-6">

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading tax rules…
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3">Tax</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Rate / Amount</th>
                <th className="px-5 py-3">Threshold</th>
                <th className="px-5 py-3">Effective from</th>
                <th className="px-5 py-3">Active</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(taxes ?? []).map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-white/[0.04] hover:bg-foreground/[0.02]"
                >
                  <td className="px-5 py-3">
                    <button
                      onClick={() => openEdit(t)}
                      className="font-medium hover:text-primary text-left"
                    >
                      {t.name}
                    </button>
                    <div className="text-[11px] text-muted-foreground">
                      <code>{t.code}</code>
                    </div>
                  </td>
                  <td className="px-5 py-3 capitalize">{t.kind}</td>
                  <td className="px-5 py-3">
                    {t.kind === "percent"
                      ? `${t.rate}%`
                      : `GY$${t.rate.toLocaleString()}`}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {t.thresholdAmount != null
                      ? `> GY$${t.thresholdAmount.toLocaleString()}`
                      : "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {t.effectiveFrom?.slice(0, 10) ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <Switch
                      checked={t.active}
                      onCheckedChange={(v) =>
                        updateTax.mutate({ id: t.id, data: { active: v } })
                      }
                      aria-label={`${t.name} active`}
                    />
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:text-red-300"
                      onClick={() => deleteTax.mutate({ id: t.id })}
                      disabled={deleteTax.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {(taxes ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-5 py-8 text-center text-muted-foreground"
                  >
                    No tax rules yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <ServiceSettingsCard />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit tax rule" : "New tax rule"}</DialogTitle>
            <DialogDescription>
              Percent rules apply a % of the price; fixed rules add a flat GYD
              amount. A threshold limits the rule to prices above it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <Label>Name</Label>
              <Input
                placeholder="e.g. VAT"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={form.kind}
                onValueChange={(v) =>
                  setForm({ ...form, kind: v as "percent" | "fixed" })
                }
              >
                <SelectTrigger className="bg-white/[0.03] border-white/10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Percent</SelectItem>
                  <SelectItem value="fixed">Fixed amount</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{form.kind === "percent" ? "Rate (%)" : "Amount (GYD)"}</Label>
              <Input
                type="number"
                min="0"
                placeholder={form.kind === "percent" ? "14" : "500"}
                value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Threshold (GYD, optional)</Label>
              <Input
                type="number"
                min="0"
                placeholder="No threshold"
                value={form.thresholdAmount}
                onChange={(e) =>
                  setForm({ ...form, thresholdAmount: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Effective from</Label>
              <Input
                type="date"
                value={form.effectiveFrom}
                onChange={(e) =>
                  setForm({ ...form, effectiveFrom: e.target.value })
                }
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Notes (optional)</Label>
              <Input
                placeholder="Internal note"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!valid || pending} onClick={submit}>
              {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? "Save changes" : "Add rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </>
  );
}

/* Service interval & late-service surcharge (dealer-configurable, GYD). */
function ServiceSettingsCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings, isLoading } = useGetServiceSettings();
  const [intervalKm, setIntervalKm] = useState<string | null>(null);
  const [fee, setFee] = useState<string | null>(null);

  const update = useUpdateServiceSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetServiceSettingsQueryKey() });
        setIntervalKm(null);
        setFee(null);
        toast({ title: "Service settings saved" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Request failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const shownInterval = intervalKm ?? (settings ? String(settings.serviceIntervalKm) : "");
  const shownFee = fee ?? (settings ? String(settings.lateSurchargeFee) : "");
  const dirty = intervalKm != null || fee != null;
  const valid =
    shownInterval.trim() !== "" &&
    Number(shownInterval) > 0 &&
    shownFee.trim() !== "" &&
    Number(shownFee) >= 0;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Wrench className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Service interval & late surcharge</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Vehicles arriving more than the interval past their last recorded service get flagged
        with a late-service surcharge suggestion on the job card. Staff can apply or waive it.
      </p>
      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <div className="space-y-2">
            <Label>Service interval (km)</Label>
            <Input
              type="number"
              min="1"
              value={shownInterval}
              onChange={(e) => setIntervalKm(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Late-service surcharge (GYD, flat)</Label>
            <Input
              type="number"
              min="0"
              value={shownFee}
              onChange={(e) => setFee(e.target.value)}
            />
          </div>
          <div>
            <Button
              disabled={!dirty || !valid || update.isPending}
              onClick={() =>
                update.mutate({
                  data: {
                    serviceIntervalKm: Number(shownInterval),
                    lateSurchargeFee: Number(shownFee),
                  },
                })
              }
            >
              {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
