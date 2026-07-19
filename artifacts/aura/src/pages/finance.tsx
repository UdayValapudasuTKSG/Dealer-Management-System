import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import {
  useListFinanceApplications,
  useListGates,
  useCreateFinanceApplication,
  getListFinanceApplicationsQueryKey,
  useGetFinanceConnectorStatus,
  useListBanks,
  useCreateBank,
  getListBanksQueryKey,
  useListInvoices,
  useCreateInvoice,
  getListInvoicesQueryKey,
  useListPayments,
  useCreatePayment,
  getListPaymentsQueryKey,
  useListReceipts,
  getListReceiptsQueryKey,
  useListOutstandingBalances,
  getListOutstandingBalancesQueryKey,
  useListLeads,
  useListCustomers,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Building,
  Landmark,
  Receipt as ReceiptIcon,
  CreditCard,
  Wallet,
  FileText,
  Wifi,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { Page, PageHeader } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ApplicationDetailDialog,
  FINANCE_STATUS_LABEL,
  statusBadgeClass,
} from "@/components/finance/application-detail";

const TABS = [
  { id: "applications", label: "Applications", icon: FileText },
  { id: "banks", label: "Banks", icon: Landmark },
  { id: "invoices", label: "Invoices & Payments", icon: CreditCard },
  { id: "receipts", label: "Receipts", icon: ReceiptIcon },
  { id: "outstanding", label: "Outstanding", icon: Wallet },
] as const;

type TabId = (typeof TABS)[number]["id"];

const money = (n: number) => `$${n.toLocaleString()}`;

export default function Finance() {
  const search = useSearch();
  const leadParam = new URLSearchParams(search).get("lead");
  const [tab, setTab] = useState<TabId>("applications");
  const [detailId, setDetailId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: apps, isLoading } = useListFinanceApplications();
  const { data: gates } = useListGates({ status: "pending" });
  const { data: connector } = useGetFinanceConnectorStatus();
  const { data: banks } = useListBanks();
  const { data: invoices } = useListInvoices();
  const { data: payments } = useListPayments();
  const { data: receipts } = useListReceipts();
  const { data: outstanding } = useListOutstandingBalances();
  const { data: leads } = useListLeads();
  const { data: customers } = useListCustomers();

  const createApp = useCreateFinanceApplication();
  const createBank = useCreateBank();
  const createInvoice = useCreateInvoice();
  const createPayment = useCreatePayment();

  const prefillLead = useMemo(
    () => (leadParam ? leads?.find((l) => l.id === Number(leadParam)) : undefined),
    [leadParam, leads],
  );
  const [appDialogOpen, setAppDialogOpen] = useState(false);
  useEffect(() => {
    if (prefillLead) setAppDialogOpen(true);
  }, [prefillLead]);

  const gatesForApp = (appId: number) =>
    (gates ?? []).filter((g) => g.refType === "finance" && g.refId === appId);

  const bankOptions = (banks ?? [])
    .filter((b) => b.active)
    .map((b) => ({ value: String(b.id), label: b.name }));

  const newApplicationDialog = (
    <CreateRecordDialog
      key={prefillLead ? `lead-${prefillLead.id}` : "blank"}
      title="New Credit Application"
      description="Capture the applicant, loan terms, employment and income — then submit to the lender."
      pending={createApp.isPending}
      submitLabel="Create application"
      open={appDialogOpen}
      onOpenChange={setAppDialogOpen}
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          New Application
        </Button>
      }
      fields={[
        { name: "customerName", label: "Applicant", type: "text", required: true, span: "half", placeholder: "Full name", ...(prefillLead ? { defaultValue: prefillLead.name } : {}) },
        { name: "bankId", label: "Bank / Lender", type: "select", span: "half", options: bankOptions },
        { name: "amount", label: "Amount financed", type: "number", required: true, span: "half", placeholder: "8500000" },
        { name: "downPayment", label: "Down payment", type: "number", span: "half", defaultValue: "0" },
        { name: "termMonths", label: "Term (months)", type: "number", required: true, span: "half", defaultValue: "60" },
        { name: "apr", label: "APR (%)", type: "number", required: true, span: "half", placeholder: "8.5" },
        { name: "employerName", label: "Employer", type: "text", span: "half", placeholder: "Company" },
        { name: "jobTitle", label: "Job title", type: "text", span: "half", placeholder: "Role" },
        {
          name: "employmentType", label: "Employment type", type: "select", span: "half",
          options: [
            { value: "employed", label: "Employed" },
            { value: "self_employed", label: "Self-employed" },
            { value: "contract", label: "Contract" },
            { value: "retired", label: "Retired" },
            { value: "other", label: "Other" },
          ],
        },
        { name: "employmentYears", label: "Years employed", type: "number", span: "half", placeholder: "4" },
        { name: "monthlyIncome", label: "Monthly income", type: "number", span: "half", placeholder: "650000" },
        { name: "otherIncome", label: "Other income", type: "number", span: "half", placeholder: "0" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        const bank = banks?.find((b) => String(b.id) === v.bankId);
        const customer = customers?.find(
          (c) => c.name.toLowerCase() === String(v.customerName).toLowerCase(),
        );
        const created = await createApp.mutateAsync({
          data: {
            ...v,
            ...(v.bankId ? { bankId: Number(v.bankId) } : {}),
            ...(bank ? { lender: bank.name } : {}),
            ...(prefillLead ? { leadId: prefillLead.id } : {}),
            ...(customer ? { customerId: customer.id } : {}),
          } as never,
        });
        queryClient.invalidateQueries({ queryKey: getListFinanceApplicationsQueryKey() });
        toast({ title: "Application created", description: "Attach documents, then submit it to the lender." });
        setDetailId(created.id);
      }}
    />
  );

  return (
    <Page className="space-y-5">
      <PageHeader
        title="Finance"
        subtitle="Credit applications, lender routing, invoicing and settlements."
        action={tab === "applications" ? newApplicationDialog : undefined}
      />

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex gap-1 bg-white/[0.03] border border-white/10 rounded-full p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-4 py-2 rounded-full text-sm font-medium tracking-wide transition-colors flex items-center gap-2 ${
                tab === t.id ? "text-white" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === t.id && (
                <motion.div
                  layoutId="finance-tab-active"
                  className="absolute inset-0 bg-primary rounded-full"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.5 }}
                />
              )}
              <t.icon className="w-4 h-4 relative z-10" />
              <span className="relative z-10">{t.label}</span>
            </button>
          ))}
        </div>
        {connector && (
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground bg-white/[0.03] border border-white/10 rounded-full px-4 py-2">
            <Wifi className={`w-3.5 h-3.5 ${connector.mode === "live" ? "text-emerald-400" : "text-amber-400"}`} />
            {connector.connector} LOS · {connector.mode === "live" ? "Live" : "Sandbox"}
          </div>
        )}
      </div>

      {tab === "applications" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {isLoading ? (
            [...Array(6)].map((_, i) => <div key={i} className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />)
          ) : apps?.length === 0 ? (
            <p className="text-muted-foreground col-span-full py-12 text-center">No credit applications yet.</p>
          ) : (
            apps?.map((app, i) => (
              <motion.div key={app.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Card
                  className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group cursor-pointer"
                  onClick={() => setDetailId(app.id)}
                >
                  <div className={`h-1.5 w-full ${["approved", "disbursed"].includes(app.status) ? "bg-primary" : "bg-white/10"}`} />
                  <CardContent className="p-6 md:p-8">
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <h3 className="font-bold text-2xl leading-tight mb-1 group-hover:text-primary transition-colors">{app.customerName}</h3>
                        <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                          <Building className="w-4 h-4" />
                          {app.lender || "Pending Lender"}
                        </div>
                      </div>
                      <Badge className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border-none ${statusBadgeClass(app.status)}`}>
                        {FINANCE_STATUS_LABEL[app.status] ?? app.status}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-3 gap-4 py-6 border-y border-border/50">
                      <div>
                        <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">Amount</div>
                        <div className="font-light text-2xl tracking-tight">{money(app.amount)}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">Term</div>
                        <div className="font-light text-2xl tracking-tight flex items-baseline gap-1">
                          {app.termMonths} <span className="text-sm font-medium text-muted-foreground mb-1 uppercase tracking-widest">MO</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">Rate</div>
                        <div className="font-light text-2xl tracking-tight text-primary flex items-baseline gap-1">
                          {app.apr} <span className="text-sm font-medium text-primary/60 mb-1 uppercase tracking-widest">APR</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-5 text-xs uppercase tracking-widest text-muted-foreground flex items-center justify-between">
                      <span>{app.statusHistory.at(-1)?.note ? "Latest activity" : "Created"}</span>
                      <span>{new Date(app.statusHistory.at(-1)?.at ?? app.createdAt).toLocaleDateString()}</span>
                    </div>
                  </CardContent>
                </Card>
                <AnimatePresence mode="popLayout">
                  {gatesForApp(app.id).map((gate) => (
                    <div key={gate.id} className="mt-4">
                      <GateCard gate={gate} label={GATE_LABEL[gate.type]} showCustomerLink={false} />
                    </div>
                  ))}
                </AnimatePresence>
              </motion.div>
            ))
          )}
        </div>
      )}

      {tab === "banks" && (
        <div className="space-y-6">
          <div className="flex justify-end">
            <CreateRecordDialog
              title="Add Bank"
              description="Register a lending partner."
              pending={createBank.isPending}
              submitLabel="Add bank"
              trigger={
                <Button variant="outline" className="rounded-full gap-2 border-white/15">
                  <Plus className="w-4 h-4" /> Add Bank
                </Button>
              }
              fields={[
                { name: "name", label: "Bank name", type: "text", required: true, span: "full" },
                { name: "code", label: "Code", type: "text", span: "half", placeholder: "DBL" },
                { name: "baseApr", label: "Base APR (%)", type: "number", span: "half", placeholder: "8.5" },
                { name: "maxTermMonths", label: "Max term (months)", type: "number", span: "half", placeholder: "72" },
                { name: "contactPhone", label: "Phone", type: "text", span: "half" },
                { name: "contactEmail", label: "Email", type: "text", span: "full" },
                { name: "address", label: "Address", type: "text", span: "full" },
              ]}
              onSubmit={async (values) => {
                await createBank.mutateAsync({ data: values as never });
                queryClient.invalidateQueries({ queryKey: getListBanksQueryKey() });
                toast({ title: "Bank added" });
              }}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {banks?.map((bank, i) => (
              <motion.div key={bank.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Card className="glass-panel border-none rounded-3xl h-full">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
                        <Landmark className="w-5 h-5 text-primary" />
                      </div>
                      {bank.code && <span className="text-xs font-mono text-muted-foreground">{bank.code}</span>}
                    </div>
                    <h3 className="font-bold text-lg mb-1">{bank.name}</h3>
                    <p className="text-sm text-muted-foreground mb-4">{bank.address ?? "—"}</p>
                    <div className="flex gap-6 text-sm">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Base APR</div>
                        <div className="text-primary font-semibold">{bank.baseApr != null ? `${bank.baseApr}%` : "—"}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Max Term</div>
                        <div className="font-semibold">{bank.maxTermMonths != null ? `${bank.maxTermMonths} mo` : "—"}</div>
                      </div>
                    </div>
                    <div className="mt-4 text-xs text-muted-foreground space-y-0.5">
                      {bank.contactPhone && <div>{bank.contactPhone}</div>}
                      {bank.contactEmail && <div>{bank.contactEmail}</div>}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {tab === "invoices" && (
        <div className="space-y-6">
          <div className="flex justify-end gap-3">
            <CreateRecordDialog
              title="New Invoice"
              description="Issue an invoice to a customer."
              pending={createInvoice.isPending}
              submitLabel="Issue invoice"
              trigger={
                <Button variant="outline" className="rounded-full gap-2 border-white/15">
                  <Plus className="w-4 h-4" /> New Invoice
                </Button>
              }
              fields={[
                { name: "customerName", label: "Customer", type: "text", required: true, span: "full" },
                { name: "amount", label: "Amount", type: "number", required: true, span: "half" },
                { name: "dueDate", label: "Due date", type: "date", span: "half" },
                { name: "description", label: "Description", type: "textarea", span: "full", placeholder: "Vehicle balance, accessories, service…" },
              ]}
              onSubmit={async (values) => {
                await createInvoice.mutateAsync({ data: values as never });
                queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListOutstandingBalancesQueryKey() });
                toast({ title: "Invoice issued" });
              }}
            />
            <CreateRecordDialog
              title="Record Payment"
              description="Record a payment against an open invoice — a receipt is issued automatically."
              pending={createPayment.isPending}
              submitLabel="Record payment"
              trigger={
                <Button className="bg-primary hover:bg-primary/90 text-white rounded-full gap-2">
                  <Plus className="w-4 h-4" /> Record Payment
                </Button>
              }
              fields={[
                {
                  name: "invoiceId", label: "Invoice", type: "select", required: true, span: "full",
                  options: (invoices ?? [])
                    .filter((inv) => inv.status === "issued" || inv.status === "partially_paid")
                    .map((inv) => ({ value: String(inv.id), label: `${inv.invoiceNumber} — ${inv.customerName} (${money(inv.amount)})` })),
                },
                { name: "amount", label: "Amount", type: "number", required: true, span: "half" },
                {
                  name: "method", label: "Method", type: "select", required: true, span: "half", defaultValue: "bank_transfer",
                  options: [
                    { value: "cash", label: "Cash" },
                    { value: "card", label: "Card" },
                    { value: "bank_transfer", label: "Bank Transfer" },
                    { value: "cheque", label: "Cheque" },
                    { value: "mobile_money", label: "Mobile Money" },
                    { value: "financing", label: "Financing" },
                  ],
                },
                { name: "reference", label: "Reference", type: "text", span: "full", placeholder: "Transfer / cheque number" },
              ]}
              onSubmit={async (values) => {
                const v = values as Record<string, unknown>;
                await createPayment.mutateAsync({ data: { ...v, invoiceId: Number(v.invoiceId) } as never });
                queryClient.invalidateQueries({ queryKey: getListPaymentsQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListReceiptsQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListOutstandingBalancesQueryKey() });
                toast({ title: "Payment recorded", description: "A receipt was issued automatically." });
              }}
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">Invoices</h3>
              <div className="space-y-3">
                {invoices?.length === 0 && <p className="text-sm text-muted-foreground italic">No invoices yet.</p>}
                {invoices?.map((inv) => (
                  <div key={inv.id} className="glass-panel rounded-2xl px-5 py-4 flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{inv.customerName}</div>
                      <div className="text-xs text-muted-foreground font-mono">{inv.invoiceNumber}{inv.description ? ` · ${inv.description}` : ""}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-light text-lg">{money(inv.amount)}</div>
                      <Badge className={`border-none rounded-full text-[9px] font-bold uppercase tracking-widest ${
                        inv.status === "paid" ? "bg-emerald-500/15 text-emerald-400"
                          : inv.status === "partially_paid" ? "bg-amber-500/15 text-amber-400"
                          : inv.status === "void" ? "bg-foreground/10 text-muted-foreground"
                          : "bg-sky-500/15 text-sky-400"
                      }`}>
                        {inv.status.replace("_", " ")}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">Payments</h3>
              <div className="space-y-3">
                {payments?.length === 0 && <p className="text-sm text-muted-foreground italic">No payments recorded yet.</p>}
                {payments?.map((p) => (
                  <div key={p.id} className="glass-panel rounded-2xl px-5 py-4 flex items-center gap-4">
                    <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <CreditCard className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{p.customerName}</div>
                      <div className="text-xs text-muted-foreground uppercase tracking-widest">{p.method.replace("_", " ")}{p.reference ? ` · ${p.reference}` : ""}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-light text-lg text-primary">{money(p.amount)}</div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-widest">{new Date(p.createdAt).toLocaleDateString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "receipts" && (
        <div className="space-y-3 max-w-3xl">
          {receipts?.length === 0 && <p className="text-sm text-muted-foreground italic">No receipts issued yet — receipts are generated automatically when payments are recorded.</p>}
          {receipts?.map((r) => (
            <div key={r.id} className="glass-panel rounded-2xl px-5 py-4 flex items-center gap-4">
              <div className="w-9 h-9 rounded-xl bg-emerald-500/10 flex items-center justify-center shrink-0">
                <ReceiptIcon className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{r.customerName}</div>
                <div className="text-xs text-muted-foreground font-mono">{r.receiptNumber} · against {r.invoiceNumber}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-light text-lg">{money(r.amount)}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  {r.method.replace("_", " ")} · {new Date(r.createdAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "outstanding" && (
        <div className="space-y-3 max-w-4xl">
          {outstanding?.length === 0 && <p className="text-sm text-muted-foreground italic">Nothing outstanding — all invoices are settled.</p>}
          {outstanding?.map((o) => {
            const pct = o.amount > 0 ? Math.min((o.paidAmount / o.amount) * 100, 100) : 0;
            return (
              <div key={o.invoiceId} className="glass-panel rounded-2xl px-5 py-4">
                <div className="flex items-center gap-4 mb-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{o.customerName}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {o.invoiceNumber}{o.dueDate ? ` · due ${o.dueDate}` : ""}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-light text-lg text-primary">{money(o.balance)} due</div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
                      {money(o.paidAmount)} of {money(o.amount)} paid
                    </div>
                  </div>
                </div>
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ApplicationDetailDialog appId={detailId} onClose={() => setDetailId(null)} />
    </Page>
  );
}
