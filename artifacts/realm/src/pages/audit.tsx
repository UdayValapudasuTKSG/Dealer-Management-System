import { useListPlatformAudit } from "@workspace/api-client-react";
import { FileText, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { formatGuyanaDateTime } from "@/lib/format";

const ACTION_COLORS: Record<string, string> = {
  provision: "text-zinc-700 border-black/10 bg-zinc-50",
  suspend: "text-rose-700 border-rose-200 bg-rose-50",
  activate: "text-emerald-700 border-emerald-200 bg-emerald-50",
  impersonate: "text-amber-800 border-amber-200 bg-amber-50",
  access_denied: "text-zinc-500 border-black/10 bg-zinc-100",
};

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 ${className || ""}`}>
      {children}
    </div>
  );
}

function PageHeader({ eyebrow, title, subtitle, right }: { eyebrow?: string; title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 flex-wrap">
      <div>
        {eyebrow && <SectionLabel>{eyebrow}</SectionLabel>}
        <h1 className="mt-2 font-serif text-4xl tracking-tight text-zinc-900">{title}</h1>
        {subtitle && (
          <p className="mt-2 text-[13.5px] text-zinc-600 max-w-2xl leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </div>
  );
}

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
    <div className="w-full px-4 md:px-6 py-8 space-y-6 font-sans">
      <PageHeader 
        eyebrow="SECURITY" 
        title="Platform Audit Log" 
        subtitle="Immutable record of high-privilege network actions." 
      />

      <div className="relative max-w-md glass rounded-xl overflow-hidden p-1 hover-elevate">
        <Search className="w-3.5 h-3.5 absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input 
          placeholder="Filter audit records..." 
          className="pl-10 bg-transparent border-none shadow-none focus-visible:ring-0 h-10 text-[13px] placeholder:text-zinc-400"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="glass rounded-2xl overflow-hidden hover-elevate">
        {isLoading && (
          <div className="p-12 text-center text-zinc-500 font-serif italic">Loading audit log...</div>
        )}

        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-zinc-500 font-serif italic">No matching records found.</div>
        ) : (
          <div className="divide-y divide-black/5">
            {filtered.map(entry => (
              <div key={entry.id} className="p-5 flex flex-col sm:flex-row gap-4 hover:bg-zinc-50/50 transition-colors group">
                <div className="mt-0.5">
                  <div className="w-9 h-9 rounded-full border border-black/5 flex items-center justify-center bg-zinc-50 group-hover:border-black/10 transition-colors">
                    <FileText className="w-3.5 h-3.5 text-zinc-400" />
                  </div>
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-1.5">
                    <h3 className="text-[13px] font-medium text-zinc-900 leading-snug">{entry.summary}</h3>
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-widest border shrink-0 w-fit ${ACTION_COLORS[entry.action] || "text-zinc-500 bg-zinc-100 border-black/10"}`}>
                      {entry.action.replace(/_/g, " ")}
                    </span>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                    <span className="text-zinc-700 font-medium">
                      {entry.actorName || entry.actorEmail || "System Automation"}
                    </span>
                    {entry.actorEmail && entry.actorName && (
                      <span className="hidden sm:inline text-zinc-400">&bull; {entry.actorEmail}</span>
                    )}
                    <span className="text-zinc-400">&bull; <span className="font-mono tracking-normal">{formatGuyanaDateTime(entry.createdAt)}</span></span>
                    <span className="font-mono text-[9px] text-zinc-400 ml-auto hidden sm:block tracking-normal">ID:{entry.id}</span>
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
