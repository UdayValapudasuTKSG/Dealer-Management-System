import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { GlLine } from "./pos-api";

export function GlTable({ lines }: { lines: GlLine[] }) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const dr = lines.reduce((s, l) => s + l.debit, 0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground" data-testid="button-toggle-gl">
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} /> GL lines ({lines.length})
      </button>
      {open && (
        <table className="mt-1 w-full max-w-3xl rounded-xl border border-white/10">
          <thead className="bg-white/[0.03] text-muted-foreground text-left"><tr><th className="px-2 py-1">Account</th><th className="px-2">Purpose</th><th className="px-2 text-right">Debit</th><th className="px-2 text-right">Credit</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-white/5"><td className="px-2 py-1 font-mono">{l.account}</td><td className="px-2 text-muted-foreground">{l.purpose}</td><td className="px-2 text-right tabular-nums">{l.debit ? money.gyd(l.debit) : ""}</td><td className="px-2 text-right tabular-nums">{l.credit ? money.gyd(l.credit) : ""}</td></tr>
            ))}
            <tr className="border-t border-white/10 font-semibold"><td className="px-2 py-1" colSpan={2}>Totals</td><td className="px-2 text-right tabular-nums">{money.gyd(dr)}</td><td className="px-2 text-right tabular-nums">{money.gyd(cr)}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
