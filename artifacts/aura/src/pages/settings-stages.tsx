import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStageChecklists,
  useSetStageChecklist,
  getListStageChecklistsQueryKey,
  type StageChecklistConfig,
  type ChecklistItemConfig,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Loader2, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

type Stage = StageChecklistConfig["stage"];

const STAGE_LABEL: Record<Stage, string> = {
  qualified: "New → Contacted",
  test_drive: "Contacted → Qualified",
  proposal: "Qualified → Proposal",
  negotiation: "Proposal → Negotiation",
  sold: "Negotiation → Won",
};

const STAGE_ORDER: Stage[] = [
  "qualified",
  "test_drive",
  "proposal",
  "negotiation",
  "sold",
];

export default function SettingsStages() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: checklists, isLoading } = useListStageChecklists();

  const [selectedStage, setSelectedStage] = useState<Stage>("qualified");
  // Draft items per stage; null = no unsaved edits for that stage.
  const [draft, setDraft] = useState<ChecklistItemConfig[] | null>(null);

  const selected = useMemo(
    () => (checklists ?? []).find((c) => c.stage === selectedStage),
    [checklists, selectedStage],
  );

  const items = draft ?? selected?.items ?? [];

  const save = useSetStageChecklist({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListStageChecklistsQueryKey() });
        setDraft(null);
        toast({ title: "Checklist saved", description: "A new version is now active for advance gates." });
      },
      onError: (err) =>
        toast({
          title: "Save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const setItem = (idx: number, patch: Partial<ChecklistItemConfig>) => {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    setDraft(next);
  };

  return (
    <>
    <PageHero
      eyebrow="Settings"
      icon={ListChecks}
      title="Stage"
      accent="Checklists"
      subtitle="Requirements a lead must meet before advancing a stage. Saving publishes a new version instantly."
    />
    <SettingsTabs />
    <div className="w-full px-5 md:px-8 pb-8 space-y-6">

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading checklists…
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          <div className="space-y-1.5">
            {STAGE_ORDER.map((stage) => {
              const cfg = (checklists ?? []).find((c) => c.stage === stage);
              return (
                <button
                  key={stage}
                  onClick={() => {
                    setSelectedStage(stage);
                    setDraft(null);
                  }}
                  className={cn(
                    "w-full text-left rounded-xl border px-4 py-3 transition-colors",
                    selectedStage === stage
                      ? "border-primary/40 bg-primary/[0.08]"
                      : "border-white/10 bg-white/[0.02] hover:bg-foreground/[0.04]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{STAGE_LABEL[stage]}</span>
                    <Badge
                      variant="outline"
                      className="border-white/20 text-muted-foreground text-[10px]"
                    >
                      v{cfg?.version ?? 0}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {(cfg?.items ?? []).filter((i) => i.enabled).length} of{" "}
                    {(cfg?.items ?? []).length} checks enabled
                  </div>
                </button>
              );
            })}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold">
                  {STAGE_LABEL[selectedStage]}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {selected?.updatedAt
                    ? `Version ${selected.version} · updated ${new Date(selected.updatedAt).toLocaleString()}${selected.updatedBy ? ` by ${selected.updatedBy}` : ""}`
                    : "Default configuration — never customized."}
                </p>
              </div>
              <Button
                size="sm"
                disabled={!draft || save.isPending}
                onClick={() =>
                  save.mutate({ stage: selectedStage, data: { items } })
                }
              >
                {save.isPending && (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                )}
                Publish new version
              </Button>
            </div>

            <div className="space-y-2">
              {items.map((it, idx) => (
                <div
                  key={it.key}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-4 py-2.5",
                    it.enabled
                      ? "border-white/10 bg-white/[0.02]"
                      : "border-white/[0.06] bg-transparent opacity-60",
                  )}
                >
                  <Switch
                    checked={it.enabled}
                    onCheckedChange={(v) => setItem(idx, { enabled: v })}
                    aria-label={`${it.key} enabled`}
                  />
                  <div className="flex-1 min-w-0">
                    <Input
                      value={it.label}
                      onChange={(e) => setItem(idx, { label: e.target.value })}
                      className="bg-transparent border-transparent hover:border-white/10 focus:border-white/20 h-8 px-2 text-sm"
                    />
                    <div className="text-[11px] text-muted-foreground px-2">
                      <code>{it.key}</code>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Disabled checks are skipped by the advance gate. Labels appear in
              the "requirements not met" messages advisors see.
            </p>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
