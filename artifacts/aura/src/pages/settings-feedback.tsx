import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetFeedbackAutomation, useUpdateFeedbackAutomation, useListFeedbackForms,
  getGetFeedbackAutomationQueryKey, type FeedbackAutomationRule } from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { MessageSquare } from "lucide-react";

export default function SettingsFeedback() {
  const { activeDealer, me } = useAuthz();
  const allowed = me?.isSuperAdmin || activeDealer?.isGeneralManager || activeDealer?.roleName === "General Manager";
  return <Page>
    <PageHero icon={MessageSquare} title="Automatic feedback" subtitle="Choose the survey and delay after each vehicle delivery or completed service visit." />
    <SettingsTabs />
    {allowed ? <FeedbackRules key={activeDealer?.dealerId} /> : <p>Only a General Manager can configure automatic feedback.</p>}
  </Page>;
}

function FeedbackRules() {
  const query = useGetFeedbackAutomation();
  const forms = useListFeedbackForms();
  const save = useUpdateFeedbackAutomation();
  const client = useQueryClient();
  const { toast } = useToast();
  const [rules, setRules] = useState<FeedbackAutomationRule[] | null>(null);
  useEffect(() => { if (query.data && rules === null) setRules(query.data.rules); }, [query.data, rules]);
  if (query.isError || forms.isError) return <div role="alert">Could not load survey settings. <Button onClick={() => { void query.refetch(); void forms.refetch(); }}>Retry</Button></div>;
  if (!rules || forms.isLoading) return <p role="status">Loading survey settings…</p>;
  const patch = (index: number, values: Partial<FeedbackAutomationRule>) =>
    setRules(rules.map((rule, i) => i === index ? { ...rule, ...values } : rule));
  const published = (forms.data ?? []).filter(f => f.status === "published");
  const valid = rules.every(r => Number.isInteger(r.delayDays) && r.delayDays >= 0 && r.delayDays <= 365 &&
    r.channels.length > 0 && (!r.enabled || published.some(f => f.id === r.formId)));
  return <div className="space-y-5 mt-6 max-w-4xl">
    <p className="text-sm text-muted-foreground">
      Create and publish the survey questions in <Link href="/feedback-forms" className="underline">Feedback Forms</Link>, then select the form below.
      Rules start with future completions when enabled. A day means 24 hours; 2 days means 48 hours after completion.
      Due surveys are checked every 10 minutes. Changes apply to unsent events; already queued messages cannot be recalled here.
    </p>
    {rules.map((rule, index) => <section key={rule.kind} className="rounded-xl border bg-card p-5 space-y-4">
      <h2 className="text-lg font-semibold">{rule.kind === "sales" ? "Sales & Vehicle Delivery Survey" : "Service & Maintenance Visit Survey"}</h2>
      <p className="text-sm text-muted-foreground">{rule.kind === "sales" ? "After the delivery workflow is completed, measured from the recorded handover time." : "After the service order is closed (customer collection), not merely when workshop work finishes."}</p>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={rule.enabled} disabled={save.isPending}
        onChange={e => patch(index, { enabled: e.target.checked })} /> Enable automatic sending</label>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="space-y-2"><Label htmlFor={`survey-${rule.kind}`}>Feedback form</Label>
          <select id={`survey-${rule.kind}`} className="w-full border rounded-md bg-background p-2" value={rule.formId ?? ""} disabled={save.isPending}
            onChange={e => patch(index, { formId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Select a published form</option>
            {(forms.data ?? []).filter(f => f.status === "published" || f.id === rule.formId).map(f =>
              <option key={f.id} value={f.id} disabled={f.status !== "published"}>{f.name}{f.status !== "published" ? ` (${f.status})` : ""}</option>)}
          </select>
        </div>
        <div className="space-y-2"><Label htmlFor={`delay-${rule.kind}`}>Send after (days)</Label>
          <Input id={`delay-${rule.kind}`} type="number" min={0} max={365} step={1} value={Number.isNaN(rule.delayDays) ? "" : rule.delayDays}
            disabled={save.isPending} onChange={e => patch(index, { delayDays: e.target.value === "" ? NaN : Number(e.target.value) })} />
        </div>
      </div>
      <fieldset className="flex gap-5"><legend className="text-sm font-medium mb-2">Send through</legend>
        {(["email", "whatsapp"] as const).map(channel => <label key={channel} className="flex gap-2 items-center">
          <input type="checkbox" checked={rule.channels.includes(channel)} disabled={save.isPending}
            onChange={e => patch(index, { channels: e.target.checked ? [...rule.channels, channel] : rule.channels.filter(c => c !== channel) })} />
          {channel === "email" ? "Email" : "WhatsApp"}
        </label>)}
      </fieldset>
      {rule.enabled && !published.some(f => f.id === rule.formId) && <p role="alert" className="text-sm text-destructive">Select a published form before enabling this rule.</p>}
      {!rule.channels.length && <p role="alert" className="text-sm text-destructive">Select at least one delivery channel.</p>}
    </section>)}
    <p className="text-xs text-muted-foreground">Uses this dealership’s configured senders and opt-out rules. WhatsApp requires an approved template outside the customer reply window. Each delivery or service order receives at most one automatic invitation; responses appear in Feedback Forms.</p>
    <Button disabled={!valid || save.isPending} onClick={() => save.mutate({ data: { rules } }, {
      onSuccess: async data => {
        if (!data?.rules) {
          await client.invalidateQueries({ queryKey: getGetFeedbackAutomationQueryKey() });
          toast({ title: "Could not confirm saved settings", description: "The server returned an empty response. Reload this page to verify before retrying.", variant: "destructive" });
          return;
        }
        setRules(data.rules); await client.invalidateQueries({ queryKey: getGetFeedbackAutomationQueryKey() });
        toast({ title: "Automatic feedback settings saved" });
      },
      onError: error => toast({ title: "Could not save", description: error.message, variant: "destructive" }),
    })}>{save.isPending ? "Saving…" : "Save feedback settings"}</Button>
  </div>;
}
