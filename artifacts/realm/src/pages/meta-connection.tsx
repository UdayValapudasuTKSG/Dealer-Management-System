import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Facebook, CheckCircle2, XCircle, Copy, Check, Pencil, X,
  Radio, KeyRound, Link2, Inbox,
} from "lucide-react";
import {
  useGetMetaConnectionStatus,
  getGetMetaConnectionStatusQueryKey,
  useUpdateDealer,
  getListDealersQueryKey,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
      {children}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="h-7 w-7 rounded-md border border-black/10 bg-white flex items-center justify-center text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 transition-colors shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function StatusPill({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-700">
      <CheckCircle2 className="w-3 h-3" /> {okLabel}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10.5px] font-medium text-amber-700">
      <XCircle className="w-3 h-3" /> {badLabel}
    </span>
  );
}

const SECRET_LABELS: Record<string, string> = {
  META_APP_SECRET: "App Secret",
  META_PAGE_ACCESS_TOKEN: "Page Access Token",
  META_VERIFY_TOKEN: "Verify Token",
};

export default function MetaConnection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useGetMetaConnectionStatus();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pageIdDraft, setPageIdDraft] = useState("");

  const updateDealer = useUpdateDealer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMetaConnectionStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });
        setEditingId(null);
        toast({ title: "Page mapping saved" });
      },
      onError: (e: any) =>
        toast({ title: "Could not save", description: e.message, variant: "destructive" }),
    },
  });

  const saveMapping = (dealer: { id: number; name: string }, pageId: string) => {
    updateDealer.mutate({
      id: dealer.id,
      data: { name: dealer.name, metaPageId: pageId.trim() || null },
    });
  };

  if (isLoading || !status) {
    return (
      <div className="w-full px-4 md:px-6 py-8">
        <div className="h-40 rounded-xl border border-black/10 bg-white shimmer" />
      </div>
    );
  }

  const mappedCount = status.dealers.filter((d) => d.metaPageId).length;

  return (
    <div className="w-full px-4 md:px-6 py-8 space-y-6 font-sans">
      <div>
        <SectionLabel>INTEGRATIONS</SectionLabel>
        <h1 className="mt-2 font-serif text-4xl tracking-tight text-zinc-900">Meta Lead Ads</h1>
        <p className="mt-2 text-[13.5px] text-zinc-600 max-w-2xl leading-relaxed">
          Capture Facebook and Instagram Lead Ads directly into each dealership's pipeline.
          Link every dealership to its Facebook Page and confirm the webhook is live.
        </p>
      </div>

      {/* Connection status */}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="glass rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-zinc-500">
            <KeyRound className="w-4 h-4" />
            <SectionLabel>Credentials</SectionLabel>
          </div>
          <StatusPill ok={status.configured} okLabel="Configured" badLabel="Not configured" />
          {!status.configured && (
            <div className="text-[12px] text-zinc-600 leading-relaxed">
              The integration is <span className="font-medium">not configured</span>. Missing secrets:{" "}
              {status.missing.map((k) => SECRET_LABELS[k] ?? k).join(", ")}.
              Add them via Replit Secrets ({status.missing.join(", ")}) and restart the API server.
            </div>
          )}
          {status.configured && (
            <div className="text-[12px] text-zinc-600">
              App secret, page access token and verify token are all set on the server.
            </div>
          )}
        </div>

        <div className="glass rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-zinc-500">
            <Radio className="w-4 h-4" />
            <SectionLabel>Webhook</SectionLabel>
          </div>
          <StatusPill
            ok={status.configured}
            okLabel="Ready to receive"
            badLabel="Offline until configured"
          />
          <div className="text-[12px] text-zinc-600 leading-relaxed">
            {mappedCount} of {status.dealers.length} dealerships linked to a Facebook Page.
          </div>
        </div>

        <div className="glass rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-zinc-500">
            <Inbox className="w-4 h-4" />
            <SectionLabel>Last Meta lead</SectionLabel>
          </div>
          {status.lastEvent ? (
            <div className="text-[12.5px] text-zinc-700 leading-relaxed">
              <div className="font-medium text-zinc-900">
                {status.lastEvent.leadName ?? `Leadgen ${status.lastEvent.externalId}`}
              </div>
              <div className="text-zinc-500">
                {status.lastEvent.leadSource === "instagram" ? "Instagram" : "Facebook"}
                {status.lastEvent.dealerName ? ` → ${status.lastEvent.dealerName}` : ""}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1">
                {new Date(status.lastEvent.createdAt).toLocaleString()}
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-zinc-500">No Meta leads received yet.</div>
          )}
        </div>
      </div>

      {/* Page mapping table */}
      <div className="glass rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-black/5 flex items-center gap-2 font-serif text-[14.5px] tracking-tight">
          <Facebook className="w-4 h-4 text-zinc-400" /> Facebook Page Mapping
          <span className="ml-auto text-[10px] font-sans font-medium uppercase tracking-[0.18em] text-zinc-500">
            Incoming leads route by Page ID
          </span>
        </div>
        <div className="divide-y divide-black/5">
          {status.dealers.map((dealer) => {
            const editing = editingId === dealer.id;
            return (
              <div key={dealer.id} className="px-5 py-3.5 flex items-center gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-zinc-900 truncate">{dealer.name}</div>
                  <div className="text-[10.5px] uppercase tracking-[0.15em] text-zinc-400">{dealer.status}</div>
                </div>
                {editing ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveMapping(dealer, pageIdDraft);
                    }}
                  >
                    <Input
                      value={pageIdDraft}
                      onChange={(e) => setPageIdDraft(e.target.value)}
                      placeholder="e.g. 112233445566778"
                      className="h-9 w-56 bg-white/60 border-black/10 rounded-md text-[13px] font-mono"
                      autoFocus
                    />
                    <button
                      type="submit"
                      disabled={updateDealer.isPending}
                      className="inline-flex items-center rounded-md bg-zinc-900 text-white px-3 py-1.5 text-[12px] font-medium hover:bg-zinc-700 transition-colors disabled:opacity-50"
                    >
                      {updateDealer.isPending ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="h-8 w-8 rounded-md border border-black/10 bg-white flex items-center justify-center text-zinc-500 hover:text-zinc-900"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center gap-3">
                    {dealer.metaPageId ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11.5px] font-mono text-emerald-800">
                        <Link2 className="w-3 h-3" /> {dealer.metaPageId}
                      </span>
                    ) : (
                      <span className="text-[12px] text-zinc-400">Not linked</span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(dealer.id);
                        setPageIdDraft(dealer.metaPageId ?? "");
                      }}
                      className="h-8 w-8 rounded-md border border-black/10 bg-white flex items-center justify-center text-zinc-500 hover:text-zinc-900 transition-colors"
                      title="Edit Page ID"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Setup guide */}
      <div className="glass rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-black/5 font-serif text-[14.5px] tracking-tight">
          Setup Guide — Meta App Dashboard
        </div>
        <div className="p-5 space-y-4 text-[13px] text-zinc-700 leading-relaxed">
          <ol className="list-decimal ml-5 space-y-3">
            <li>
              In <span className="font-medium">Meta for Developers → your App → Webhooks</span>, add a{" "}
              <span className="font-medium">Page</span> subscription with this callback URL:
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 rounded-md bg-zinc-50 border border-black/5 px-3 py-2 text-[12px] font-mono text-zinc-800 break-all">
                  {status.callbackUrl}
                </code>
                <CopyButton value={status.callbackUrl} />
              </div>
            </li>
            <li>
              Paste your <span className="font-medium">Verify Token</span> (the value you saved as{" "}
              <code className="text-[12px] bg-zinc-50 border border-black/5 rounded px-1">META_VERIFY_TOKEN</code>)
              into the "Verify token" field, then click Verify and Save. Meta calls the URL above with a
              challenge; the server echoes it back automatically once the secrets are set.
            </li>
            <li>
              Subscribe the webhook to the <span className="font-medium">leadgen</span> field.
            </li>
            <li>
              Subscribe each Facebook Page to your app (Graph API:{" "}
              <code className="text-[12px] bg-zinc-50 border border-black/5 rounded px-1">
                POST /&#123;page-id&#125;/subscribed_apps?subscribed_fields=leadgen
              </code>{" "}
              with the page access token), then enter that Page's ID in the mapping table above.
              Instagram Lead Ads run through the linked Facebook Page — no separate setup needed.
            </li>
            <li>
              Send a test lead with Meta's{" "}
              <span className="font-medium">Lead Ads Testing Tool</span>{" "}
              (developers.facebook.com/tools/lead-ads-testing) and confirm it appears in the "Last Meta
              lead" panel and on the dealership's pipeline with source Facebook/Instagram.
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}
