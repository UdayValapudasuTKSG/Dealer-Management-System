import { useListPlatformAudit } from "@workspace/api-client-react";
import { FileText, Search, Filter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { formatGuyanaDateTime } from "@/lib/format";

const ACTION_COLORS: Record<string, string> = {
  provision: "text-black bg-black/5 border-black/20",
  suspend: "text-muted-foreground bg-gray-100 border-border",
  activate: "text-black bg-black/5 border-black/20",
  impersonate: "text-black bg-white border-black",
  access_denied: "text-muted-foreground bg-gray-100 border-border",
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-3xl font-serif text-foreground">Platform Audit Log</h1>
          <p className="text-sm text-muted-foreground mt-2 uppercase tracking-widest">Immutable record of high-privilege network actions</p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input 
          placeholder="Filter audit records..." 
          className="pl-9 bg-white border-border rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-black"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-white border border-border">
        {isLoading && (
          <div className="p-12 text-center text-muted-foreground font-serif italic">Loading audit log...</div>
        )}

        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground font-serif italic">No matching records found.</div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map(entry => (
              <div key={entry.id} className="p-5 flex flex-col sm:flex-row gap-5 hover:bg-gray-50 transition-colors group">
                <div className="mt-1">
                  <div className="w-8 h-8 border border-border flex items-center justify-center bg-gray-50 group-hover:border-black/20 transition-colors">
                    <FileText className="w-4 h-4 text-black" />
                  </div>
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
                    <h3 className="font-serif text-base text-black">{entry.summary}</h3>
                    <span className={`inline-flex px-2 py-0.5 rounded-none text-[9px] font-medium uppercase tracking-widest border shrink-0 w-fit ${ACTION_COLORS[entry.action] || "text-muted-foreground bg-gray-50 border-border"}`}>
                      {entry.action.replace(/_/g, " ")}
                    </span>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                    <span className="text-black font-medium">
                      {entry.actorName || entry.actorEmail || "System Automation"}
                    </span>
                    {entry.actorEmail && entry.actorName && (
                      <span className="hidden sm:inline opacity-70">&bull; {entry.actorEmail}</span>
                    )}
                    <span className="opacity-70">&bull; {formatGuyanaDateTime(entry.createdAt)}</span>
                    <span className="font-mono text-[9px] opacity-40 ml-auto hidden sm:block tracking-normal">ID:{entry.id}</span>
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
