import type { PosRequest, PosState } from "./pos-api";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number | undefined) => `GYD ${(n ?? 0).toLocaleString("en-GY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function printReceipt(req: PosRequest, state: PosState, dealerName: string) {
  const s = req.snapshot;
  const posted = req.status === "posted";
  const label = posted ? "POSTED" : `${req.status.toUpperCase()} — NOT A FINAL TAX INVOICE`;
  const tenders = "tenders" in req.input ? req.input.tenders : [];
  const srcLabel = (id: string) => state.config.sources.find((x) => x.id === id)?.label ?? id;
  const lines = (s?.lines ?? [])
    .map((l) => `<tr><td>${esc(l.sku)} ${esc(l.name)}<br><small>${esc(l.itemCode)}</small></td><td class=r>${esc(l.quantity)}</td><td class=r>${money(l.unitPrice)}</td><td class=r>${money(l.net)}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt #${esc(req.id)}</title>
<style>body{font:12px/1.4 ui-monospace,monospace;max-width:320px;margin:16px auto;color:#222}h1{font-size:15px;margin:0}table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}.r{text-align:right}.tag{border:1px solid #222;padding:4px;text-align:center;font-weight:bold;margin:8px 0}hr{border:0;border-top:1px dashed #999}</style></head>
<body><h1>${esc(dealerName)}</h1><div>Parts counter — ${esc(req.kind.replace("_", " "))} #${esc(req.id)}</div>
<div>Ref: ${esc(req.input.reference)} · ${esc(s?.date ?? req.createdAt)}</div>
<div>Customer: ${esc(s?.customerName || "Walk-in")}</div>
<div class=tag>${esc(label)}</div>
<table>${lines}</table><hr>
<table><tr><td>Net (VAT excl.)</td><td class=r>${money(s?.net)}</td></tr><tr><td>VAT</td><td class=r>${money(s?.tax)}</td></tr><tr><td><b>Total</b></td><td class=r><b>${money(s?.total)}</b></td></tr>
${tenders.map((t) => `<tr><td>${esc(srcLabel(t.sourceId))}</td><td class=r>${money(t.amount)}</td></tr>`).join("")}
<tr><td>Balance on account</td><td class=r>${money(s?.balance)}</td></tr>
${req.input.kind === "shift_close" ? `
<tr><td>Opening float</td><td class=r>${money(req.input.openingFloat)}</td></tr>
<tr><td>Expected cash</td><td class=r>${money(s?.expectedCash)}</td></tr>
<tr><td>Counted cash</td><td class=r>${money(req.input.countedCash)}</td></tr>
<tr><td>Actual over / (short)</td><td class=r>${money(s?.variance)}</td></tr>
<tr><td>Transfer to ${esc(srcLabel(req.input.destinationSourceId))}</td><td class=r>${money(req.input.transferAmount)}</td></tr>` : ""}
</table><hr>
<div>ERP: ${req.erpDocuments.length ? req.erpDocuments.map((d) => `${esc(d.doctype)} ${esc(d.name)}`).join(", ") : "not yet posted"}</div>
<script>window.onload=()=>{window.print()}</script></body></html>`;
  const w = window.open("", "_blank", "width=420,height=640");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
