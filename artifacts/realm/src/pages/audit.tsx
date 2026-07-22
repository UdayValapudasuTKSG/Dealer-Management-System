import { useListPlatformAudit } from "@workspace/api-client-react";
import { FileText, Search, Filter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { formatGuyanaDateTime } from "@/lib/format";

const ACTION_COLORS: Record<string, string> = {
  provision: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
  suspend: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  activate: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
  impersonate: "text-primary bg-primary/10 border-primary/20",
  access_denied: "text-destructive bg-destructive/10 border-destructive/20",
};

export default function Audit() {
  const { data: audit, isLoading } = useListPlatformAudit({ limit: 500 });
  const [search, setSearch] = useState("");

  const filtered = (audit ?? []).filter(e => 
    e.summary.toLowerCase().includes(search.toLowerCase()) ||
    (e.actorName || "").toLowerCase().includes(search.toLowerCase()) ||
    (e.actorEmail || "").toLowerCase().includes(search.toLowerCase()) ||
    e.action.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Platform Audit Log</h1>
          <p className="text-muted-foreground mt-1">Immutable record of high-privilege network actions.</p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input 
          placeholder="Filter audit records..." 
          className="pl-9 bg-card/50 border-white/10"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-card/30 border border-white/5 rounded-2xl overflow-hidden">
        {isLoading && (
          <div className="p-12 text-center text-muted-foreground animate-pulse">Loading audit log...</div>
        )}

        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">No matching records found.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {filtered.map(entry => (
              <div key={entry.id} className="p-4 sm:p-5 flex flex-col sm:flex-row gap-4 hover:bg-white/[0.02] transition-colors group">
                <div className="mt-1">
                  <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center group-hover:border-white/20 transition-colors">
                    <FileText className="w-4 h-4 text-muted-foreground group-hover:text-white" />
                  </div>
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-1.5">
                    <h3 className="font-medium text-white text-sm">{entry.summary}</h3>
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border shrink-0 w-fit ${ACTION_COLORS[entry.action] || "text-muted-foreground bg-white/5 border-white/10"}`}>
                      {entry.action.replace(/_/g, " ")}
                    </span>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    <span className="text-white/70 font-medium">
                      {entry.actorName || entry.actorEmail || "System Automation"}
                    </span>
                    {entry.actorEmail && entry.actorName && (
                      <span className="hidden sm:inline opacity-50">&bull; {entry.actorEmail}</span>
                    )}
                    <span className="opacity-50">&bull; {formatGuyanaDateTime(entry.createdAt)}</span>
                    <span className="font-mono text-[10px] opacity-40 ml-auto hidden sm:block">ID:{entry.id}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
