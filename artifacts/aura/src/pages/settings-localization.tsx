import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetDealerLocalization,
  useUpdateDealerLocalization,
  getGetDealerLocalizationQueryKey,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { formatGuyanaDateTime } from "@/lib/format";
import { Check, Clock, Globe2, Loader2 } from "lucide-react";

const FALLBACK_ZONES = ["America/Guyana", "UTC"];

function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return FALLBACK_ZONES;
  }
}

/** "GMT-4" style offset label for a zone, right now. */
function offsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * GM-only dealership timezone. Every date, time, calendar boundary, schedule
 * and generated document across AURA follows this setting; historical
 * timestamps are never rewritten — only how they are displayed changes.
 */
export default function SettingsLocalization() {
  const { activeDealer, me } = useAuthz();
  const isGm =
    !!activeDealer?.isGeneralManager ||
    activeDealer?.roleName === "General Manager" ||
    !!me?.isSuperAdmin;

  if (!isGm) {
    return (
      <Page>
        <PageHero
          title="Localization"
          subtitle="Only the general manager can manage the dealership timezone."
        />
        <SettingsTabs />
      </Page>
    );
  }

  return (
    <Page>
      <PageHero
        title="Localization"
        subtitle="Timezone settings have moved into Branding."
      />
      <SettingsTabs />
      <div className="px-5 md:px-8 pb-10 max-w-4xl">
        <LocalizationSettingsPanel />
      </div>
    </Page>
  );
}

export function LocalizationSettingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeDealer, me } = useAuthz();
  const isGm =
    !!activeDealer?.isGeneralManager ||
    activeDealer?.roleName === "General Manager" ||
    !!me?.isSuperAdmin;

  const { data, isLoading } = useGetDealerLocalization({
    query: { enabled: isGm },
  } as never);
  const current = data?.timezone ?? "America/Guyana";

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = selected ?? current;

  const zones = useMemo(allTimeZones, []);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/\s+/g, "_");
    const list = q
      ? zones.filter((z) => z.toLowerCase().includes(q))
      : zones;
    return list.slice(0, 60);
  }, [zones, search]);

  const update = useUpdateDealerLocalization({
    mutation: {
      onSuccess: async () => {
        setSelected(null);
        // /auth/me carries the timezone every formatter uses; ALL other
        // cached data (dashboards, calendars, day-grouped lists) may hold
        // ranges or groupings computed under the old zone — refresh
        // everything so the app re-renders in the new zone immediately.
        // (AuthProvider also re-invalidates when it observes the change.)
        await qc.invalidateQueries();
        toast({
          title: "Timezone updated",
          description: "All dates and schedules now follow the new timezone.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Could not save timezone",
          description:
            (e as { data?: { error?: string } })?.data?.error ??
            "Please try again.",
          variant: "destructive",
        }),
    },
  });

  if (!isGm) return null;

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
          <div className="flex items-start gap-3">
            <Globe2 className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="font-medium">Dealership timezone</h2>
              <p className="text-sm text-muted-foreground">
                Applies to calendars, test-drive slots, task due dates,
                reminders, emails and generated documents. Past records keep
                their original moment in time — only how they are shown
                changes.
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-testid="text-current-timezone">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{current.replace(/_/g, " ")}</span>
                <span className="text-muted-foreground">
                  {offsetLabel(current)} · now{" "}
                  {new Date().toLocaleTimeString("en-US", {
                    timeZone: current,
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              <Input
                placeholder="Search timezones — e.g. Georgetown, New York, London…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-timezone-search"
              />
              <div className="max-h-72 overflow-y-auto rounded-lg border divide-y">
                {filtered.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">
                    No timezone matches "{search}".
                  </p>
                )}
                {filtered.map((tz) => (
                  <button
                    key={tz}
                    type="button"
                    onClick={() => setSelected(tz)}
                    data-testid={`option-timezone-${tz}`}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60 ${
                      chosen === tz ? "bg-muted/50 font-medium" : ""
                    }`}
                  >
                    <span>{tz.replace(/_/g, " ")}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {offsetLabel(tz)}
                      {chosen === tz && <Check className="h-4 w-4 text-primary" />}
                    </span>
                  </button>
                ))}
              </div>

              {selected && selected !== current && (
                <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
                  Preview: it is currently{" "}
                  <span className="font-medium">
                    {formatGuyanaDateTime(new Date()) /* current zone */}
                  </span>{" "}
                  here — in {selected.replace(/_/g, " ")} it is{" "}
                  <span className="font-medium">
                    {new Date().toLocaleString("en-US", {
                      timeZone: selected,
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  .
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  disabled={update.isPending || !selected || selected === current}
                  onClick={() =>
                    selected && update.mutate({ data: { timezone: selected } })
                  }
                  data-testid="button-save-timezone"
                >
                  {update.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Save timezone
                </Button>
              </div>
            </>
          )}
    </div>
  );
}
