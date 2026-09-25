import { Router, type RequestHandler } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { ObjectStorageService, objectStorageClient } from "../lib/objectStorage";
import { setObjectAclPolicy, getObjectAclPolicy } from "../lib/objectAcl";
import { minor } from "../lib/supplier-invoice-money";
import { InvoiceError, invoiceTransaction, invoiceAudit, lockedPo, poLines, lineFlags, varianceSnapshot, reconcileInvoice } from "../lib/supplier-invoices";

const router = Router(), storage = new ObjectStorageService();
const id = z.coerce.number().int().positive();
const money = z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/);
const payload = z.object({
  invoiceNumber: z.string().trim().min(1).max(120), invoiceDate: z.iso.date(),
  shipping: money, duties: money, tax: money, total: money,
  toleranceBps: z.number().int().min(0).max(10000).default(0),
  lines: z.array(z.object({ partNumber: z.string().trim().min(1).max(120), description: z.string().max(1000),
    quantity: z.number().int().min(0).max(1000000), unitCost: money })).min(1).max(500),
});
const endpoint = (permission: "view" | "edit" | "approve", fn: (req: any, res: any, dealer: number, actor: number, location: number) => Promise<unknown>): RequestHandler => async (req,res) => {
  try {
    const user = res.locals.user;
    if (!user) throw new InvoiceError("Authentication required",401);
    if (!hasPermission(user,"parts",permission)) throw new InvoiceError(`Parts ${permission} permission required`,403);
    const dealer = activeDealerId(res);
    if (!Number.isSafeInteger(dealer) || dealer <= 0) throw new InvoiceError("Select a dealership",400);
    const location = id.parse(req.query.locationId);
    const result = await fn(req,res,dealer,user.id,location);
    if (!res.headersSent) res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) { res.status(400).json({error:"Invalid invoice input",details:error.issues}); return; }
    res.status(error instanceof InvoiceError ? error.status : error.code==="23505" ? 409 : 500)
      .json({error:error instanceof InvoiceError ? error.message : error.code==="23505" ? "This supplier invoice number already exists" : "Supplier invoice operation failed; no database changes committed"});
  }
};
router.get("/purchase-orders/:poId",endpoint("view",async(req,_res,d,_a,l)=>invoiceTransaction(async c=>{
  const po=await lockedPo(c,d,l,id.parse(req.params.poId));
  const lines=await poLines(c,d,po.id);
  const invoices=(await c.query("SELECT * FROM supplier_invoices WHERE dealer_id=$1 AND location_id=$2 AND po_id=$3 ORDER BY id DESC",[d,l,po.id])).rows;
  for(const invoice of invoices) {
    invoice.lines=(await c.query("SELECT * FROM supplier_invoice_lines WHERE invoice_id=$1 ORDER BY id",[invoice.id])).rows.map(line=>({...line,match_status:invoice.status==="reconciled"?line.match_status:lineFlags(line,lines.find(p=>p.id===line.po_line_id),invoice.tolerance_bps)}));
  }
  return {po,lines,invoices};
})));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:1}});
// Authenticate before accepting the multipart body.
router.post("/purchase-orders/:poId",endpoint("edit",async(req,res,d,a,l)=>{
  await new Promise<void>((resolve,reject)=>upload.single("file")(req,res,(err:any)=>err?reject(new InvoiceError(err.message,400)):resolve()));
  const file=req.file;
  if(!file) throw new InvoiceError("Attach a PDF, JPG or PNG",400);
  const bytes=file.buffer as Buffer;
  const valid=file.mimetype==="application/pdf" ? bytes.subarray(0,5).toString()==="%PDF-" :
    file.mimetype==="image/jpeg" ? bytes[0]===255&&bytes[1]===216&&bytes[2]===255 :
    file.mimetype==="image/png" ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : false;
  if(!valid) throw new InvoiceError("Only authentic PDF, JPG and PNG files are accepted",400);
  let parsed: unknown; try { parsed=JSON.parse(req.body.invoice); } catch { throw new InvoiceError("Invalid invoice JSON",400); }
  const data=payload.parse(parsed), poId=id.parse(req.params.poId);
  let saved: any;
  try {
    return await invoiceTransaction(async c=>{
      const po=await lockedPo(c,d,l,poId);
      if(["closed","cancelled"].includes(po.status.toLowerCase())) throw new InvoiceError("Cannot attach invoices to a closed or cancelled PO");
      const ordered=await poLines(c,d,poId);
      const lines=data.lines.map(line=>{
        const matches=ordered.filter(p=>p.part_number?.trim().toLowerCase()===line.partNumber.toLowerCase());
        if(matches.length>1) throw new InvoiceError(`Ambiguous PO part number ${line.partNumber}`);
        return {po_line_id:matches[0]?.id??null,part_number:line.partNumber,description:line.description,quantity:line.quantity,unit_cost_minor:minor(line.unitCost).toString()};
      });
      const subtotal=lines.reduce((sum,line)=>sum+BigInt(line.quantity)*BigInt(line.unit_cost_minor),0n);
      if(subtotal+minor(data.shipping)+minor(data.duties)+minor(data.tax)!==minor(data.total)) throw new InvoiceError("Total must equal lines plus shipping, duties and tax",400);
      const dir=storage.getPrivateObjectDir().replace(/^\/|\/$/g,""), [bucket,...prefix]=dir.split("/");
      const key=`uploads/dealer-${d}/location-${l}/supplier-invoices/${randomUUID()}`;
      saved=objectStorageClient.bucket(bucket).file(`${prefix.join("/")}/${key}`);
      await saved.save(bytes,{contentType:file.mimetype,resumable:false});
      await setObjectAclPolicy(saved,{owner:`dealer-${d}`,visibility:"private"});
      const invoice=(await c.query(`INSERT INTO supplier_invoices(dealer_id,location_id,supplier_id,po_id,invoice_number,invoice_date,object_path,file_name,
        subtotal_minor,shipping_minor,duties_minor,tax_minor,total_minor,tolerance_bps,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [d,l,po.supplier_id,poId,data.invoiceNumber,data.invoiceDate,`/objects/${key}`,file.originalname,subtotal.toString(),minor(data.shipping).toString(),minor(data.duties).toString(),minor(data.tax).toString(),minor(data.total).toString(),data.toleranceBps,a])).rows[0];
      for(const line of lines) await c.query(`INSERT INTO supplier_invoice_lines(invoice_id,po_line_id,part_number,description,quantity,unit_cost_minor,match_status)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[invoice.id,line.po_line_id,line.part_number,line.description,line.quantity,line.unit_cost_minor,JSON.stringify(lineFlags(line,ordered.find(p=>p.id===line.po_line_id),data.toleranceBps))]);
      await invoiceAudit(c,d,a,invoice.id,"Supplier invoice uploaded",{before:null,after:"pending",invoiceNumber:data.invoiceNumber,lines});
      return invoice;
    });
  } catch(error) { if(saved) await saved.delete().catch(()=>undefined); throw error; }
}));
router.patch("/:invoiceId",endpoint("edit",async(req,_res,d,a,l)=>invoiceTransaction(async c=>{
  const data=payload.parse(req.body),invoiceId=id.parse(req.params.invoiceId);
  const initial=(await c.query("SELECT po_id FROM supplier_invoices WHERE id=$1 AND dealer_id=$2 AND location_id=$3",[invoiceId,d,l])).rows[0];
  if(!initial)throw new InvoiceError("Invoice not found",404);
  await lockedPo(c,d,l,initial.po_id);
  const invoice=(await c.query("SELECT * FROM supplier_invoices WHERE id=$1 FOR UPDATE",[invoiceId])).rows[0];
  if(invoice.status!=="pending")throw new InvoiceError("Reconciled invoices are immutable");
  const ordered=await poLines(c,d,invoice.po_id);
  const lines=data.lines.map(line=>{
    const matches=ordered.filter(p=>p.part_number?.trim().toLowerCase()===line.partNumber.toLowerCase());
    if(matches.length>1)throw new InvoiceError(`Ambiguous PO part number ${line.partNumber}`);
    return {po_line_id:matches[0]?.id??null,part_number:line.partNumber,description:line.description,quantity:line.quantity,unit_cost_minor:minor(line.unitCost).toString()};
  });
  const subtotal=lines.reduce((sum,line)=>sum+BigInt(line.quantity)*BigInt(line.unit_cost_minor),0n);
  if(subtotal+minor(data.shipping)+minor(data.duties)+minor(data.tax)!==minor(data.total))throw new InvoiceError("Total must equal lines plus shipping, duties and tax",400);
  const previousLines=(await c.query("SELECT * FROM supplier_invoice_lines WHERE invoice_id=$1",[invoiceId])).rows;
  await c.query("DELETE FROM supplier_invoice_lines WHERE invoice_id=$1",[invoiceId]);
  for(const line of lines)await c.query(`INSERT INTO supplier_invoice_lines(invoice_id,po_line_id,part_number,description,quantity,unit_cost_minor,match_status)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[invoiceId,line.po_line_id,line.part_number,line.description,line.quantity,line.unit_cost_minor,JSON.stringify(lineFlags(line,ordered.find(p=>p.id===line.po_line_id),data.toleranceBps))]);
  await c.query(`UPDATE supplier_invoices SET invoice_number=$1,invoice_date=$2,subtotal_minor=$3,shipping_minor=$4,duties_minor=$5,tax_minor=$6,total_minor=$7,tolerance_bps=$8 WHERE id=$9`,
    [data.invoiceNumber,data.invoiceDate,subtotal.toString(),minor(data.shipping).toString(),minor(data.duties).toString(),minor(data.tax).toString(),minor(data.total).toString(),data.toleranceBps,invoiceId]);
  await invoiceAudit(c,d,a,invoiceId,"Supplier invoice edited; variance approvals reset",{before:{...invoice,lines:previousLines},after:{...data,status:"pending"}});
  return {id:invoiceId,status:"pending"};
})));
router.post("/:invoiceId/accept-variance",endpoint("approve",async(req,_res,d,a,l)=>invoiceTransaction(async c=>{
  const input=z.object({lineId:id,reason:z.string().trim().min(3).max(2000)}).parse(req.body);
  const invoice=(await c.query("SELECT * FROM supplier_invoices WHERE id=$1 AND dealer_id=$2 AND location_id=$3 FOR UPDATE",[id.parse(req.params.invoiceId),d,l])).rows[0];
  if(!invoice) throw new InvoiceError("Invoice not found",404);
  if(invoice.status!=="pending") throw new InvoiceError("Reconciled invoices are immutable");
  const line=(await c.query("UPDATE supplier_invoice_lines SET accepted_reason=$1,accepted_by=$2,accepted_at=now() WHERE id=$3 AND invoice_id=$4 RETURNING *",[input.reason,a,input.lineId,invoice.id])).rows[0];
  if(!line) throw new InvoiceError("Line not found",404);
  const ordered=await poLines(c,d,invoice.po_id);
  await c.query("UPDATE supplier_invoice_lines SET accepted_snapshot=$1 WHERE id=$2",[JSON.stringify(varianceSnapshot(line,ordered.find(p=>p.id===line.po_line_id),invoice.tolerance_bps)),line.id]);
  await invoiceAudit(c,d,a,invoice.id,"Supplier invoice variance accepted",{lineId:line.id,reason:input.reason,flags:lineFlags(line,ordered.find(p=>p.id===line.po_line_id),invoice.tolerance_bps),before:"unaccepted",after:"accepted"});
  return line;
})));
router.post("/:invoiceId/reconcile",endpoint("approve",async(req,_res,d,a,l)=>reconcileInvoice(d,l,a,id.parse(req.params.invoiceId))));
router.get("/:invoiceId/file",endpoint("view",async(req,res,d,_a,l)=>{
  const invoice=(await pool.query("SELECT object_path FROM supplier_invoices WHERE id=$1 AND dealer_id=$2 AND location_id=$3",[id.parse(req.params.invoiceId),d,l])).rows[0];
  if(!invoice) throw new InvoiceError("Invoice not found",404);
  const file=await storage.getObjectEntityFile(invoice.object_path),acl=await getObjectAclPolicy(file);
  if(acl?.visibility!=="private"||acl.owner!==`dealer-${d}`) throw new InvoiceError("File access denied",403);
  const [metadata]=await file.getMetadata();
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("Content-Type",metadata.contentType||"application/octet-stream");
  res.setHeader("Content-Disposition","attachment");
  res.flushHeaders();
  file.createReadStream().on("error",()=>res.destroy()).pipe(res);
}));
export default router;