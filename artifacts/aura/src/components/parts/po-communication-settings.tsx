import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { customFetch, useListPartsLocations, useListSuppliers } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
const base = "/api/parts/operations";
export function PoCommunicationSettings() {
  const { can } = useAuthz();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState("");
  const [draft, setDraft] = useState<any>(null);
  const [supplier, setSupplier] = useState("");
  const [cc, setCc] = useState("");
  const locations = useListPartsLocations();
  const suppliers = useListSuppliers();
  const settings = useQuery({ queryKey: ["po-settings", location], enabled: !!location && open, queryFn: () => customFetch<any>(`${base}/communication-settings/${location}`) });
  const sms = useQuery({ queryKey: ["po-sms-readiness"], enabled: open, queryFn: () => customFetch<any>(`${base}/notifications/sms-settings`) });
  const value = draft ?? settings.data;
  const save = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => customFetch(`${base}/${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    onSuccess: () => { toast({ title: "Communication settings saved" }); void settings.refetch(); },
    onError: error => toast({ title: "Could not save", description: error.message, variant: "destructive" }),
  });
  if (!can("settings", "admin")) return null;
  return <><Button variant="outline" onClick={() => setOpen(true)}>Email & alert settings</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Parts communication settings</DialogTitle><DialogDescription>Settings are scoped to this dealership and inventory branch. In-app receipt alerts are always enabled.</DialogDescription></DialogHeader>
    <Label>Branch<select className="block w-full rounded border bg-background p-2" value={location} onChange={e => { setLocation(e.target.value); setDraft(null); }}><option value="">Select location</option>{locations.data?.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Label>
    {settings.isError && <p className="text-destructive">{settings.error.message}</p>}
    {sms.isError && <p className="text-destructive">{sms.error.message}</p>}
    {sms.data && <p className={sms.data.ready ? "text-sm text-muted-foreground" : "text-sm text-amber-600"}>{sms.data.ready ? "Dealer SMS gateway is configured." : sms.data.reason}</p>}
    {value && <><p className="text-xs text-muted-foreground">Template placeholders: {"{{po_number}}, {{supplier_name}}, {{branch}}, {{expected_date}}, {{sender_name}}"}</p><Label>Subject<Input value={value.subject} onChange={e => setDraft({ ...value, subject: e.target.value })} /></Label><Label>Body HTML<Textarea rows={5} value={value.body_html} onChange={e => setDraft({ ...value, body_html: e.target.value })} /></Label>{(["sms_enabled", "parts_manager", "service_manager", "customer_sms"] as const).map(key => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value[key]} onChange={e => setDraft({ ...value, [key]: e.target.checked })} />{({ sms_enabled: "Enable staff SMS (requires configured Twilio sender)", parts_manager: "Notify Parts Managers", service_manager: "Notify Service Managers", customer_sms: "Also SMS the linked customer (off by default)" })[key]}</label>)}<Button disabled={save.isPending} onClick={() => save.mutate({ path: `communication-settings/${location}`, body: { subject: value.subject, body_html: value.body_html, sms_enabled: value.sms_enabled, parts_manager: value.parts_manager, service_manager: value.service_manager, customer_sms: value.customer_sms } })}>Save branch settings</Button></>}
    <hr /><Label>Supplier CC addresses<select className="block w-full rounded border bg-background p-2" value={supplier} onChange={e => { setSupplier(e.target.value); const selected = suppliers.data?.find(s => s.id === Number(e.target.value)); setCc(((selected as any)?.ccEmails ?? []).join(", ")); }}><option value="">Select supplier</option>{suppliers.data?.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></Label><Input value={cc} onChange={e => setCc(e.target.value)} placeholder="buyer@example.com, accounts@example.com" /><Button variant="outline" disabled={!supplier || save.isPending} onClick={() => save.mutate({ path: `suppliers/${supplier}/cc-emails`, body: { ccEmails: cc.split(",").map(s => s.trim()).filter(Boolean) } })}>Save supplier CC</Button>
  </DialogContent></Dialog></>;
}