import { useListPlatformAudit } from "@workspace/api-client-react";
import { FileText, Search, Filter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { formatGuyanaDateTime } from "@/lib/format";

const ACTION_COLORS: Record<string, string> = {
  provision: "text-foreground bg-white/[0.08] border-white/10",
  suspend: "text-muted-foreground bg-black/20 border-white/5",
  activate: "text-foreground bg-white/[0.08] border-white/10",
  impersonate: "text-foreground bg-white/10 border-white/20",
  access_denied: "text-muted-foreground bg-black/20 border-white/5",
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
    <div className="space-y-8 font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-serif tracking-wide">Platform Audit Log</h1>
          <p className="text-xs text-muted-foreground mt-2 uppercase tracking-[0.15em]">Immutable record of high-privilege network actions</p>
        </div>
      </div>

      <div className="relative max-w-md glass-panel rounded-2xl overflow-hidden p-1">
        <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 opacity-50" />
        <Input 
          placeholder="Filter audit records..." 
          className="pl-11 bg-transparent border-none shadow-none focus-visible:ring-0 h-12 text-sm placeholder:text-muted-foreground/50"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="glass-panel rounded-2xl overflow-hidden">
        {isLoading && (
          <div className="p-12 text-center text-muted-foreground font-serif italic">Loading audit log...</div>
        )}

        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground font-serif italic">No matching records found.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {filtered.map(entry => (
              <div key={entry.id} className="p-5 flex flex-col sm:flex-row gap-5 hover:bg-white/[0.02] transition-colors group">
                <div className="mt-1">
                  <div className="w-10 h-10 rounded-xl border border-white/5 flex items-center justify-center bg-white/[0.03] group-hover:border-white/10 transition-colors">
                    <FileText className="w-4 h-4 opacity-70" />
                  </div>
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
                    <h3 className="font-serif text-base tracking-wide">{entry.summary}</h3>
                    <span className={`inline-flex px-2 py-0.5 rounded-md text-[9px] font-medium uppercase tracking-widest border shrink-0 w-fit ${ACTION_COLORS[entry.action] || "text-muted-foreground bg-black/20 border-white/5"}`}>
                      {entry.action.replace(/_/g, " ")}
                    </span>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    <span className="text-foreground/80 font-medium">
                      {entry.actorName || entry.actorEmail || "System Automation"}
                    </span>
                    {entry.actorEmail && entry.actorName && (
                      <span className="hidden sm:inline opacity-50">&bull; {entry.actorEmail}</span>
                    )}
                    <span className="opacity-50">&bull; {formatGuyanaDateTime(entry.createdAt)}</span>
                    <span className="font-mono text-[9px] opacity-30 ml-auto hidden sm:block tracking-normal">ID:{entry.id}</span>
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

