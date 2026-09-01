import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListVehicleModelGlCodes,
  useUpsertVehicleModelGlCode,
  useValidateVehicleModelGlCodes,
  getListVehicleModelGlCodesQueryKey,
  type VehicleModelGlCode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import {
  ArrowLeft,
  BadgeCheck,
  BadgeX,
  BookOpen,
  Loader2,
  Search,
  ShieldAlert,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Finance → Vehicle Model GL Codes: one dealership GL account code per
// normalized make/model. Variants/trims/VINs inherit the model's mapping.
// ---------------------------------------------------------------------------

type Draft = { glCode: string; accountName: string };

function rowKey(m: VehicleModelGlCode): string {
  return `${m.makeKey}|${m.modelKey}`;
}

function ErpnextBadge({ value }: { value: VehicleModelGlCode["erpnext"] }) {
  switch (value) {
    case "verified":
      return (
        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1">
          <BadgeCheck className="w-3 h-3" /> Verified
        </Badge>
      );
    case "invalid":
      return (
        <Badge className="bg-red-500/15 text-red-400 border-red-500/30 gap-1">
          <BadgeX className="w-3 h-3" /> Invalid
        </Badge>
      );
    case "unchecked":
      return (
        <Badge className="bg-white/5 text-muted-foreground border-white/10">
          Unchecked
        </Badge>
      );
    default:
      return (
        <span className="text-xs text-muted-foreground/60">Not connected</span>
      );
  }
}

export default function FinanceGlCodes() {
  const { can } = useAuthz();
  const canView = can("finance", "view");
  const canEdit = can("finance", "edit");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useListVehicleModelGlCodes();
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListVehicleModelGlCodesQueryKey() });

  const upsert = useUpsertVehicleModelGlCode({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "GL code saved" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not save GL code",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const validate = useValidateVehicleModelGlCodes({
    mutation: {
      onSuccess: (r) => {
        invalidate();
        toast({
          title: "ERPNext validation complete",
          description: `${r.verified} verified · ${r.invalid} invalid of ${r.checked} checked`,
        });
      },
      onError: (err: unknown) =>
        toast({
          title: "Validation failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const models = data?.models ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) =>
      [m.make, m.model, m.glCode ?? "", m.accountName ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [models, search]);

  const configured = models.filter((m) => m.status === "configured").length;
  const missing = models.length - configured;

  const draftFor = (m: VehicleModelGlCode): Draft =>
    drafts[rowKey(m)] ?? {
      glCode: m.glCode ?? "",
      accountName: m.accountName ?? "",
    };

  const setDraft = (m: VehicleModelGlCode, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [rowKey(m)]: { ...draftFor(m), ...patch } }));

  const isDirty = (m: VehicleModelGlCode): boolean => {
    const d = drafts[rowKey(m)];
    if (!d) return false;
    return (
      d.glCode.trim() !== (m.glCode ?? "") ||
      d.accountName.trim() !== (m.accountName ?? "")
    );
  };

  const save = async (m: VehicleModelGlCode) => {
    const d = draftFor(m);
    if (!d.glCode.trim()) {
      toast({ title: "GL code must not be blank", variant: "destructive" });
      return;
    }
    setSavingKey(rowKey(m));
    try {
      await upsert.mutateAsync({
        data: {
          make: m.make,
          model: m.model,
          glCode: d.glCode.trim(),
          accountName: d.accountName.trim() || null,
        },
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[rowKey(m)];
        return next;
      });
    } catch {
      /* toast handled in onError */
    } finally {
      setSavingKey(null);
    }
  };

  if (!canView) {
    return (
      <Page className="pt-10">
        <div className="glass-panel rounded-2xl border border-white/10 p-10 text-center space-y-3">
          <ShieldAlert className="w-8 h-8 mx-auto text-amber-400" />
          <p className="text-sm text-muted-foreground">
            You need Finance view access to see vehicle model GL codes.
          </p>
        </div>
      </Page>
    );
  }

  return (
    <>
      <PageHero
        eyebrow="Finance Desk"
        title="Vehicle Model GL Codes"
        subtitle="One dealership GL account code per make/model — every variant, trim and VIN inherits it."
        className="pb-3"
        action={
          <Link href="/finance">
            <Button variant="outline" className="rounded-full h-9 gap-1.5 text-sm">
              <ArrowLeft className="w-4 h-4" /> Back to Finance
            </Button>
          </Link>
        }
      />
      <Page className="space-y-4 pt-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="relative w-72 max-w-full">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search make, model or code…"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {configured} configured · {missing} missing
            </span>
            {data?.erpnextConnected && (
              <Button
                size="sm"
                variant="outline"
                className="rounded-full gap-1.5"
                disabled={!canEdit || validate.isPending || configured === 0}
                onClick={() => validate.mutate()}
              >
                {validate.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <BookOpen className="w-3.5 h-3.5" />
                )}
                Validate with ERPNext
              </Button>
            )}
          </div>
        </div>

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            View-only: your role can inspect mappings but not change them.
          </p>
        )}

        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Make / Model</th>
                <th className="px-4 py-3 font-semibold text-right hidden md:table-cell">
                  Vehicles
                </th>
                <th className="px-4 py-3 font-semibold">GL Code</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">
                  Account Name
                </th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">
                  ERPNext
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground text-sm">
                    {models.length === 0
                      ? "No vehicle models in inventory yet — models appear here automatically."
                      : "No models match your search."}
                  </td>
                </tr>
              )}
              {filtered.map((m) => {
                const d = draftFor(m);
                const key = rowKey(m);
                return (
                  <tr key={key} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">
                        {m.make} {m.model}
                      </div>
                      {m.vehicleCount === 0 && (
                        <div className="text-[11px] text-muted-foreground">
                          No longer in inventory
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right hidden md:table-cell text-muted-foreground">
                      {m.vehicleCount}
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        value={d.glCode}
                        onChange={(e) => setDraft(m, { glCode: e.target.value })}
                        placeholder="e.g. 4110 - Vehicle Sales"
                        disabled={!canEdit}
                        className="h-8 w-44"
                      />
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <Input
                        value={d.accountName}
                        onChange={(e) =>
                          setDraft(m, { accountName: e.target.value })
                        }
                        placeholder="Optional account name"
                        disabled={!canEdit}
                        className="h-8 w-48"
                      />
                    </td>
                    <td className="px-4 py-3">
                      {m.status === "configured" ? (
                        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                          Configured
                        </Badge>
                      ) : (
                        <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">
                          Missing
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <ErpnextBadge value={m.erpnext} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canEdit && (
                        <Button
                          size="sm"
                          className="h-8 rounded-full"
                          disabled={!isDirty(m) || savingKey === key}
                          onClick={() => void save(m)}
                        >
                          {savingKey === key ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            "Save"
                          )}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Page>
    </>
  );
}
