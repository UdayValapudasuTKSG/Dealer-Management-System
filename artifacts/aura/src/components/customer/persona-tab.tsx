import { useEffect, useState } from "react";
import {
  useUpsertCustomerPersona,
  useRecommendCustomerVehicle,
  getGetCustomerOverviewQueryKey,
  type CustomerPersona,
  type CustomerPersonaInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Sparkles, Gauge, Car, Save } from "lucide-react";
import { cn } from "@/lib/utils";

const withBase = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;

const AGE_GROUPS = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
const PROBABILITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "very_high", label: "Very High" },
] as const;
const COMM_PREFS = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "sms", label: "SMS" },
  { value: "in_person", label: "In Person" },
] as const;

type FormState = {
  ageGroup: string;
  incomeRange: string;
  buyingBudget: string;
  familySize: string;
  vehiclePreference: string;
  brandPreference: string;
  fuelPreference: string;
  drivingHabits: string;
  purchaseMotivation: string;
  lifestyle: string;
  buyingProbability: string;
  financeRequired: string;
  tradeIn: string;
  previousPurchases: string;
  communicationPreference: string;
  marketingConsent: string;
};

function fromPersona(p: CustomerPersona | null | undefined): FormState {
  const bool = (v: boolean | null | undefined) =>
    v === true ? "yes" : v === false ? "no" : "";
  return {
    ageGroup: p?.ageGroup ?? "",
    incomeRange: p?.incomeRange ?? "",
    buyingBudget: p?.buyingBudget != null ? String(p.buyingBudget) : "",
    familySize: p?.familySize != null ? String(p.familySize) : "",
    vehiclePreference: p?.vehiclePreference ?? "",
    brandPreference: p?.brandPreference ?? "",
    fuelPreference: p?.fuelPreference ?? "",
    drivingHabits: p?.drivingHabits ?? "",
    purchaseMotivation: p?.purchaseMotivation ?? "",
    lifestyle: p?.lifestyle ?? "",
    buyingProbability: p?.buyingProbability ?? "",
    financeRequired: bool(p?.financeRequired),
    tradeIn: bool(p?.tradeIn),
    previousPurchases:
      p?.previousPurchases != null ? String(p.previousPurchases) : "",
    communicationPreference: p?.communicationPreference ?? "",
    marketingConsent: bool(p?.marketingConsent),
  };
}

function scoreTone(score: number) {
  if (score >= 70) return "text-emerald-400";
  if (score >= 40) return "text-amber-400";
  return "text-muted-foreground";
}

export function PersonaTab({
  customerId,
  persona,
}: {
  customerId: number;
  persona: CustomerPersona | null | undefined;
}) {
  const [form, setForm] = useState<FormState>(() => fromPersona(persona));
  const [dirty, setDirty] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const upsert = useUpsertCustomerPersona();
  const recommend = useRecommendCustomerVehicle();

  useEffect(() => {
    if (!dirty) setForm(fromPersona(persona));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona]);

  const set = (name: keyof FormState, value: string) => {
    setDirty(true);
    setForm((f) => ({ ...f, [name]: value }));
  };

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetCustomerOverviewQueryKey(customerId),
    });

  const save = async () => {
    const bool = (v: string) => (v === "yes" ? true : v === "no" ? false : null);
    const data: CustomerPersonaInput = {
      ageGroup: (form.ageGroup || null) as CustomerPersonaInput["ageGroup"],
      incomeRange: form.incomeRange || null,
      buyingBudget: form.buyingBudget ? Number(form.buyingBudget) : null,
      familySize: form.familySize ? Number(form.familySize) : null,
      vehiclePreference: form.vehiclePreference || null,
      brandPreference: form.brandPreference || null,
      fuelPreference: form.fuelPreference || null,
      drivingHabits: form.drivingHabits || null,
      purchaseMotivation: form.purchaseMotivation || null,
      lifestyle: form.lifestyle || null,
      buyingProbability: (form.buyingProbability ||
        null) as CustomerPersonaInput["buyingProbability"],
      financeRequired: bool(form.financeRequired),
      tradeIn: bool(form.tradeIn),
      previousPurchases: form.previousPurchases
        ? Number(form.previousPurchases)
        : null,
      communicationPreference: (form.communicationPreference ||
        null) as CustomerPersonaInput["communicationPreference"],
      marketingConsent: bool(form.marketingConsent),
    };
    try {
      await upsert.mutateAsync({ id: customerId, data });
      setDirty(false);
      await invalidate();
      toast({
        title: "Persona saved",
        description: "Lead score recalculated from the updated profile.",
      });
    } catch {
      toast({ title: "Could not save persona", variant: "destructive" });
    }
  };

  const runRecommend = async () => {
    try {
      await recommend.mutateAsync({ id: customerId });
      await invalidate();
      toast({
        title: "Recommendation ready",
        description: "AURA matched this client against live inventory.",
      });
    } catch {
      toast({
        title: "Recommendation failed",
        description: "The AI engine could not produce a match. Try again.",
        variant: "destructive",
      });
    }
  };

  const leadScore = persona?.leadScore ?? 0;
  const reco = persona?.aiRecommendedVehicle;

  const selectField = (
    label: string,
    name: keyof FormState,
    options: readonly { value: string; label: string }[],
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Select value={form[name]} onValueChange={(v) => set(name, v)}>
        <SelectTrigger className="bg-white/[0.04] border-white/10">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const textField = (
    label: string,
    name: keyof FormState,
    placeholder?: string,
    type: "text" | "number" = "text",
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Input
        type={type}
        value={form[name]}
        placeholder={placeholder}
        onChange={(e) => set(name, e.target.value)}
        className="bg-white/[0.04] border-white/10"
      />
    </div>
  );

  const yesNo = [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ] as const;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* Score + AI recommendation column */}
      <div className="space-y-6">
        <Card className="glass-panel border-none shadow-lg overflow-hidden">
          <CardContent className="p-6 flex flex-col items-center text-center">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-4 flex items-center gap-2">
              <Gauge className="w-4 h-4" /> Lead Score
            </div>
            <div className="relative w-36 h-36">
              <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                <circle
                  cx="60"
                  cy="60"
                  r="52"
                  fill="none"
                  strokeWidth="8"
                  className="stroke-white/10"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="52"
                  fill="none"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${(leadScore / 100) * 326.7} 326.7`}
                  className="stroke-primary transition-all duration-700"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span
                  className={cn(
                    "text-4xl font-light tracking-tight",
                    scoreTone(leadScore),
                  )}
                >
                  {leadScore}
                </span>
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  of 100
                </span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-4">
              Computed from persona completeness, buying intent, live leads and
              deal history.
            </p>
          </CardContent>
        </Card>

        <Card className="glass-panel border-none shadow-lg overflow-hidden">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" /> AI Match
              </div>
              <Button
                size="sm"
                onClick={runRecommend}
                disabled={recommend.isPending}
                className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 gap-2"
              >
                {recommend.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {reco ? "Re-match" : "Recommend"}
              </Button>
            </div>
            {reco ? (
              <div className="space-y-3">
                <div className="rounded-2xl overflow-hidden bg-white/[0.04] border border-white/10">
                  {reco.imageUrl ? (
                    <img
                      src={withBase(reco.imageUrl)}
                      alt={`${reco.make} ${reco.model}`}
                      className="w-full h-36 object-cover"
                    />
                  ) : (
                    <div className="w-full h-36 flex items-center justify-center">
                      <Car className="w-8 h-8 text-muted-foreground/30" />
                    </div>
                  )}
                  <div className="p-4">
                    <p className="font-semibold">
                      {reco.year} {reco.make} {reco.model}
                    </p>
                    <p className="text-sm text-primary font-medium">
                      ${reco.price.toLocaleString("en-US")}
                    </p>
                  </div>
                </div>
                {persona?.aiRecommendationReason && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {persona.aiRecommendationReason}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No recommendation yet. Fill in the persona and let AURA match
                this client against live inventory.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Persona editor */}
      <Card className="glass-panel border-none shadow-lg lg:col-span-2">
        <CardContent className="p-6 md:p-8 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Persona Profile
            </h3>
            <Button
              onClick={save}
              disabled={upsert.isPending || !dirty}
              className="bg-primary hover:bg-primary/90 text-white rounded-full px-5 gap-2"
            >
              {upsert.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              Save Persona
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {selectField(
              "Age Group",
              "ageGroup",
              AGE_GROUPS.map((v) => ({ value: v, label: v })),
            )}
            {textField("Income Range", "incomeRange", "e.g. $80k–120k")}
            {textField("Buying Budget ($)", "buyingBudget", "150000", "number")}
            {textField("Family Size", "familySize", "4", "number")}
            {textField("Vehicle Preference", "vehiclePreference", "SUV, Coupe…")}
            {textField("Brand Preference", "brandPreference", "e.g. BMW")}
            {textField("Fuel Preference", "fuelPreference", "Hybrid, EV…")}
            {textField("Driving Habits", "drivingHabits", "City commute…")}
            {textField("Purchase Motivation", "purchaseMotivation", "Status, family…")}
            {textField("Lifestyle", "lifestyle", "Executive, outdoors…")}
            {selectField("Buying Probability", "buyingProbability", PROBABILITIES)}
            {textField(
              "Previous Purchases",
              "previousPurchases",
              "0",
              "number",
            )}
            {selectField("Finance Required", "financeRequired", yesNo)}
            {selectField("Trade-in Expected", "tradeIn", yesNo)}
            {selectField(
              "Communication Preference",
              "communicationPreference",
              COMM_PREFS,
            )}
            {selectField("Marketing Consent", "marketingConsent", yesNo)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
