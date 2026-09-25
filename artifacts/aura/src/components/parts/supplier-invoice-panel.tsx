import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, useListPurchaseOrders } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const base = "/api/parts/supplier-invoices";
const amount = (v: string) => `${BigInt(v)/100n}.${(BigInt(v)%100n).toString().padStart(2,"0")}`;
type EditLine = {partNumber:string;description:string;quantity:number;unitCost:string};
/** May also be mounted directly on a PO: <SupplierInvoicePanel purchaseOrderId={po.id} locationId={po.locationId} /> */
export function SupplierInvoicePanel({purchaseOrderId,locationId}:{purchaseOrderId?:number;locationId?:number|null}) {
  const {can}=useAuthz(),qc=useQueryClient();
  const orders=useListPurchaseOrders();
  const [selected,setSelected]=useState(""),[editing,setEditing]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [file,setFile]=useState<File|null>(null),[lines,setLines]=useState<EditLine[]>([]);
  const [editingInvoice,setEditingInvoice]=useState<number|null>(null);
  const [header,setHeader]=useState({invoiceNumber:"",invoiceDate:"",shipping:"0.00",duties:"0.00",tax:"0.00",total:"",toleranceBps:0});
  const poId=purchaseOrderId||Number(selected);
  const order=(orders.data as any[]|undefined)?.find(p=>p.id===poId);
  const branch=locationId??order?.locationId;
  const query=useQuery({queryKey:["supplier-invoices",poId,branch],enabled:!!poId&&!!branch,
    queryFn:()=>customFetch<any>(`${base}/purchase-orders/${poId}?locationId=${branch}`)});
  async function action(fn:()=>Promise<unknown>) {
    setBusy(true);setError("");
    try { await fn(); await qc.invalidateQueries({queryKey:["supplier-invoices"]}); }
    catch(e) {setError(e instanceof Error?e.message:"Invoice request failed");}
    finally{setBusy(false);}
  }
  async function post(invoice:number,path:string,body={}) {
    return customFetch(`${base}/${invoice}/${path}?locationId=${branch}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  }
  function start() {
    setEditingInvoice(null);setFile(null);
    setLines(query.data.lines.map((l:any)=>({partNumber:l.part_number??"",description:l.part_name,quantity:Math.max(0,l.qty_received-l.invoiced_quantity),unitCost:Number(l.unit_cost).toFixed(2)})));
    setEditing(true);
  }
  function editInvoice(invoice:any) {
    setEditingInvoice(invoice.id);
    setHeader({invoiceNumber:invoice.invoice_number,invoiceDate:String(invoice.invoice_date).slice(0,10),shipping:amount(invoice.shipping_minor),duties:amount(invoice.duties_minor),tax:amount(invoice.tax_minor),total:amount(invoice.total_minor),toleranceBps:invoice.tolerance_bps});
    setLines(invoice.lines.map((line:any)=>({partNumber:line.part_number,description:line.description,quantity:line.quantity,unitCost:amount(line.unit_cost_minor)})));
    setEditing(true);
  }
  return <section className="space-y-4 rounded-2xl border border-border p-5">
    <div><h2 className="text-lg font-semibold">Supplier purchase invoices</h2><p className="text-sm text-muted-foreground">Match ordered, received and invoiced quantities. Partial invoices use the received balance not already reconciled. Reconciliation changes cost only, never stock. Quantities above that balance must be received first; repeated part numbers on a PO require consolidation before costing.</p></div>
    {!purchaseOrderId&&<label className="block text-sm">Purchase order
      <select className="mt-1 w-full rounded border border-border bg-background p-2" value={selected} onChange={e=>{setSelected(e.target.value);setEditing(false);setError("");}}>
        <option value="">Select a PO</option>{(orders.data as any[]|undefined)?.map(p=><option key={p.id} value={p.id}>{p.reference||`PO #${p.id}`} — {p.status}</option>)}
      </select></label>}
    {orders.error&&<p role="alert" className="text-destructive">Unable to load purchase orders: {orders.error.message}</p>}
    {!!poId&&!branch&&<p role="alert" className="text-destructive">This PO needs an explicit branch/location before uploading an invoice.</p>}
    {query.isLoading&&<p>Loading PO and invoices…</p>}
    {query.error&&<p role="alert" className="text-destructive">{query.error.message}</p>}
    {error&&<p role="alert" className="text-destructive">{error}</p>}
    {query.data&&can("parts","edit")&&!editing&&<Button onClick={start}>Upload Supplier Invoice</Button>}
    {editing&&<form className="space-y-4" onSubmit={e=>{e.preventDefault();void action(async()=>{
      if(editingInvoice) {
        await customFetch(`${base}/${editingInvoice}?locationId=${branch}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({...header,lines})});
        setEditing(false);return;
      }
      if(!file)throw new Error("Choose an invoice PDF, JPG or PNG");
      if(file.size>10*1024*1024)throw new Error("File exceeds 10 MB");
      const form=new FormData();form.append("file",file);form.append("invoice",JSON.stringify({...header,lines}));
      await customFetch(`${base}/purchase-orders/${poId}?locationId=${branch}`,{method:"POST",body:form});setEditing(false);
    });}}>
      {!editingInvoice&&<label className="block text-sm">Invoice file (PDF/JPG/PNG, maximum 10 MB)<Input required type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e=>setFile(e.target.files?.[0]??null)}/></label>}
      {editingInvoice&&<p className="text-sm text-muted-foreground">Editing resets variance acceptances. The original attachment is retained.</p>}
      <div className="grid gap-3 sm:grid-cols-3">{(["invoiceNumber","invoiceDate","shipping","duties","tax","total"] as const).map(key=><label key={key} className="text-sm">{({invoiceNumber:"Invoice number",invoiceDate:"Invoice date",shipping:"Shipping",duties:"Duties",tax:"Tax",total:"Invoice total"})[key]}
        <Input required type={key==="invoiceDate"?"date":"text"} value={header[key]} onChange={e=>setHeader({...header,[key]:e.target.value})}/></label>)}
        <label className="text-sm">Tolerance % (default 0)<Input type="number" min="0" max="100" step=".01" value={header.toleranceBps/100} onChange={e=>setHeader({...header,toleranceBps:Math.round(Number(e.target.value)*100)})}/></label></div>
      <div className="overflow-auto"><table className="w-full text-sm"><thead><tr>{["Part number","Description","Invoiced qty","Unit cost",""].map(h=><th key={h} className="p-2 text-left">{h}</th>)}</tr></thead><tbody>{lines.map((line,i)=><tr key={i}>
        {(["partNumber","description","quantity","unitCost"] as const).map(key=><td key={key} className="p-1"><Input required value={line[key]} type={key==="quantity"?"number":"text"} min="0" onChange={e=>setLines(lines.map((v,j)=>j===i?{...v,[key]:key==="quantity"?Number(e.target.value):e.target.value}:v))}/></td>)}
        <td><Button type="button" variant="ghost" onClick={()=>setLines(lines.filter((_,j)=>i!==j))}>Remove</Button></td></tr>)}</tbody></table></div>
      <div className="flex gap-2"><Button type="button" variant="outline" onClick={()=>setLines([...lines,{partNumber:"",description:"",quantity:0,unitCost:"0.00"}])}>Add line</Button>
      <Button disabled={busy} type="submit">{busy?"Uploading…":"Save invoice"}</Button><Button type="button" variant="ghost" onClick={()=>setEditing(false)}>Cancel</Button></div>
    </form>}
    {query.data?.invoices.map((invoice:any)=><article key={invoice.id} className="rounded-xl border border-border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{invoice.invoice_number} · {String(invoice.invoice_date).slice(0,10)} · {invoice.status}</h3>
        <Button variant="outline" onClick={()=>void action(async()=>{const response=await customFetch<Blob>(`${base}/${invoice.id}/file?locationId=${branch}&v=${Date.now()}`,{responseType:"blob",cache:"no-store"}); const url=URL.createObjectURL(response);const anchor=document.createElement("a");anchor.href=url;anchor.download=invoice.file_name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);})}>Download invoice</Button></div>
      <p className="text-sm">Subtotal {amount(invoice.subtotal_minor)} · Shipping {amount(invoice.shipping_minor)} · Duties {amount(invoice.duties_minor)} · Tax {amount(invoice.tax_minor)} · Total {amount(invoice.total_minor)}</p>
      <div className="overflow-auto"><table className="w-full text-sm"><thead><tr>{["Part","Ordered","Received","Invoiced","PO unit cost","Invoice unit cost","Match / acceptance"].map(h=><th key={h} className="p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>{invoice.lines.map((line:any)=>{const po=query.data.lines.find((p:any)=>p.id===line.po_line_id);return <tr key={line.id} className="border-t border-border">
          <td className="p-2">{line.part_number}</td><td>{po?.quantity??"—"}</td><td>{po?.qty_received??"—"}{po&&<small className="block text-muted-foreground">{po.invoiced_quantity} already reconciled</small>}</td><td>{line.quantity}</td><td>{po?Number(po.unit_cost).toFixed(2):"—"}</td><td>{amount(line.unit_cost_minor)}</td>
          <td className="p-2">{line.match_status.length?line.match_status.join(", "):"Matched"}{line.accepted_reason&&<p className="text-muted-foreground">Accepted: {line.accepted_reason}</p>}{invoice.status==="pending"&&line.match_status.length>0&&can("parts","approve")&&<AcceptVariance disabled={busy} onAccept={reason=>void action(()=>post(invoice.id,"accept-variance",{lineId:line.id,reason}))}/>}</td>
        </tr>})}</tbody></table></div>
      <div className="flex gap-2">{invoice.status==="pending"&&can("parts","edit")&&<Button variant="outline" disabled={busy} onClick={()=>editInvoice(invoice)}>Edit invoice</Button>}
      {invoice.status==="pending"&&can("parts","approve")&&<Button disabled={busy} onClick={()=>void action(()=>post(invoice.id,"reconcile"))}>Mark Reconciled</Button>}</div>
    </article>)}
  </section>;
}
function AcceptVariance({onAccept,disabled}:{onAccept:(reason:string)=>void;disabled:boolean}) {
  const [reason,setReason]=useState("");
  return <div className="mt-2 flex gap-2"><Label className="sr-only">Variance reason</Label><Input aria-label="Variance acceptance reason" placeholder="Reason (required)" value={reason} onChange={e=>setReason(e.target.value)}/><Button size="sm" variant="outline" disabled={disabled||reason.trim().length<3} onClick={()=>onAccept(reason)}>Accept variance</Button></div>;
}