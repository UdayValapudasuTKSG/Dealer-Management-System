import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
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
  useGetReceipt,
  useListOutstandingBalances,
  getListOutstandingBalancesQueryKey,
  useListLeads,
  useListCustomers,
  useListDeals,
  getListDealsQueryKey,
  type PaymentInput,
  type InvoiceInput,
  type Invoice,
  type OutstandingBalance,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import {
  Plus,
  Building,
  Landmark,
  Receipt as ReceiptIcon,
  CreditCard,
  Wallet,
  FileText,
  Wifi,
  BookOpen,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { motion, AnimatePresence } from "framer-motion";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { Page } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
import {
  ApplicationDetailDialog,
  FINANCE_STATUS_LABEL,
  statusBadgeClass,
} from "@/components/finance/application-detail";
import { PageHero } from "@/components/layout/page-hero";
import { useMoney, formatGuyanaDate } from "@/lib/format";

const TABS = [
  { id: "applications", label: "Applications", icon: FileText },
  { id: "banks", label: "Banks", icon: Landmark },
  { id: "invoices", label: "Invoices & Payments", icon: CreditCard },
  { id: "receipts", label: "Receipts", icon: ReceiptIcon },
  { id: "outstanding", label: "Outstanding", icon: Wallet },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Finance() {
  const search = useSearch();
  const leadParam = new URLSearchParams(search).get("lead");
  const [tab, setTab] = useState<TabId>("applications");
  const { density, setDensity, layout, setLayout } = useViewMode("finance");
  const compactRow = density === "compact" ? "py-2.5" : "py-3.5";
  const [detailId, setDetailId] = useState<number | null>(null);
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rawMoney = useMoney();
  const money = (n: number) => rawMoney.gyd(n);

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
  const { data: deals } = useListDeals();

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
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
          <Plus className="w-4 h-4" />
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
    <>
    <PageHero
      eyebrow="Finance Desk"
      title="Finance"
      subtitle="Credit applications, lender routing, invoicing and settlements."
      className="pb-3"
      action={tab === "applications" ? newApplicationDialog : undefined}
    />
    <Page className="space-y-4 pt-0">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 bg-white/[0.03] border border-white/10 rounded-full p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-3 py-1.5 rounded-full text-sm font-medium tracking-wide transition-colors flex items-center gap-1.5 ${
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
              <t.icon className="w-3.5 h-3.5 relative z-10" />
              <span className="relative z-10">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Link href="/finance/gl-codes">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full h-8 gap-1.5 text-xs"
            >
              <BookOpen className="w-3.5 h-3.5" />
              Vehicle Model GL Codes
            </Button>
          </Link>
          <ViewControls
            layout={layout}
            onLayoutChange={setLayout}
            density={density}
            onDensityChange={setDensity}
          />
          {connector && (
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground bg-white/[0.03] border border-white/10 rounded-full px-3 py-1.5">
              <Wifi className={`w-3.5 h-3.5 ${connector.mode === "live" ? "text-emerald-400" : "text-amber-400"}`} />
              {connector.connector} LOS · {connector.mode === "live" ? "Live" : "Sandbox"}
            </div>
          )}
        </div>
      </div>

      {tab === "applications" && layout === "list" && (
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Customer</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Lender</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Amount</th>
                <th className="px-4 py-3 font-semibold text-right hidden md:table-cell">Term</th>
                <th className="px-4 py-3 font-semibold text-right hidden lg:table-cell">APR</th>
              </tr>
            </thead>
            <tbody>
              {(apps ?? []).map((app) => (
                <tr
                  key={app.id}
                  className="border-b border-white/5 hover:bg-foreground/[0.03] transition-colors cursor-pointer"
                  onClick={() => setDetailId(app.id)}
                >
                  <td className={`px-4 font-medium ${compactRow}`}>{app.customerName}</td>
                  <td className="px-4 py-2 text-muted-foreground hidden md:table-cell">
                    {app.lender || "Pending"}
                  </td>
                  <td className="px-4 py-2">
                    <Badge className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border-none ${statusBadgeClass(app.status)}`}>
                      {FINANCE_STATUS_LABEL[app.status] ?? app.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">{money(app.amount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums hidden md:table-cell">{app.termMonths} mo</td>
                  <td className="px-4 py-2 text-right tabular-nums text-primary hidden lg:table-cell">{app.apr}%</td>
                </tr>
              ))}
              {(apps ?? []).length === 0 && !isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground text-sm">
                    No credit applications yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "applications" && layout !== "list" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {isLoading ? (
            [...Array(6)].map((_, i) => <div key={i} className="h-48 bg-white/[0.05] rounded-2xl animate-pulse" />)
          ) : apps?.length === 0 ? (
            <p className="text-muted-foreground col-span-full py-12 text-center">No credit applications yet.</p>
          ) : (
            apps?.map((app, i) => (
              <motion.div key={app.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Card
                  className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-2xl overflow-hidden group cursor-pointer"
                  onClick={() => setDetailId(app.id)}
                >
                  <div className={`h-1 w-full ${["approved", "disbursed"].includes(app.status) ? "bg-primary" : "bg-white/10"}`} />
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-3 gap-2">
                      <div className="min-w-0">
                        <h3 className="font-bold text-base leading-tight mb-0.5 truncate group-hover:text-primary transition-colors">{app.customerName}</h3>
                        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Building className="w-3.5 h-3.5" />
                          {app.lender || "Pending Lender"}
                        </div>
                      </div>
                      <Badge className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border-none shrink-0 ${statusBadgeClass(app.status)}`}>
                        {FINANCE_STATUS_LABEL[app.status] ?? app.status}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-3 gap-3 py-3 border-y border-border/50">
                      <div>
                        <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-0.5">Amount</div>
                        <div className="font-light text-lg tracking-tight truncate">{money(app.amount)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-0.5">Term</div>
                        <div className="font-light text-lg tracking-tight flex items-baseline gap-1">
                          {app.termMonths} <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">MO</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-0.5">Rate</div>
                        <div className="font-light text-lg tracking-tight text-primary flex items-baseline gap-1">
                          {app.apr} <span className="text-[10px] font-medium text-primary/60 uppercase tracking-widest">APR</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-3 text-[10px] uppercase tracking-widest text-muted-foreground flex items-center justify-between">
                      <span>{app.statusHistory.at(-1)?.note ? "Latest activity" : "Created"}</span>
                      <span>{formatGuyanaDate(app.statusHistory.at(-1)?.at ?? app.createdAt)}</span>
                    </div>
                  </CardContent>
                </Card>
                <AnimatePresence mode="popLayout">
                  {gatesForApp(app.id).map((gate) => (
                    <div key={gate.id} className="mt-3">
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
        <div className="space-y-4">
          <div className="flex justify-end">
            <CreateRecordDialog
              title="Add Bank"
              description="Register a lending partner."
              pending={createBank.isPending}
              submitLabel="Add bank"
              trigger={
                <Button variant="outline" size="sm" className="rounded-full gap-1.5 border-white/15 h-9">
                  <Plus className="w-4 h-4" /> Add Bank
                </Button>
              }
              fields={[
                { name: "name", label: "Bank name", type: "text", required: true, span: "full" },
                { name: "code", label: "Code", type: "text", span: "half", placeholder: "DBL" },
                { name: "baseApr", label: "Base APR (%)", type: "number", span: "half", placeholder: "8.5" },
                { name: "maxTermMonths", label: "Max term (months)", type: "number", span: "half", placeholder: "72" },
                { name: "contactPhone", label: "Phone", type: "phone", span: "half" },
                { name: "contactEmail", label: "Email", type: "email", span: "full" },
                { name: "address", label: "Address", type: "text", span: "full" },
              ]}
              onSubmit={async (values) => {
                await createBank.mutateAsync({ data: values as never });
                queryClient.invalidateQueries({ queryKey: getListBanksQueryKey() });
                toast({ title: "Bank added" });
              }}
            />
          </div>
          {layout === "list" ? (
            <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Bank</th>
                    <th className="px-4 py-3 font-semibold hidden md:table-cell">Code</th>
                    <th className="px-4 py-3 font-semibold text-right">Base APR</th>
                    <th className="px-4 py-3 font-semibold text-right">Max Term</th>
                    <th className="px-4 py-3 font-semibold hidden lg:table-cell">Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {(banks ?? []).map((bank) => (
                    <tr key={bank.id} className="border-b border-white/5 last:border-0">
                      <td className={`px-4 font-medium ${compactRow}`}>
                        {bank.name}
                        <div className="text-xs text-muted-foreground font-normal">{bank.address ?? ""}</div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground hidden md:table-cell">{bank.code ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-primary font-semibold">{bank.baseApr != null ? `${bank.baseApr}%` : "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{bank.maxTermMonths != null ? `${bank.maxTermMonths} mo` : "—"}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground hidden lg:table-cell">
                        {[bank.contactPhone, bank.contactEmail].filter(Boolean).join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                  {(banks ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground text-sm">No banks registered yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {banks?.map((bank, i) => (
              <motion.div key={bank.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Card className="glass-panel border-none rounded-2xl h-full">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                          <Landmark className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-bold text-sm truncate">{bank.name}</h3>
                          <p className="text-xs text-muted-foreground truncate">{bank.address ?? "—"}</p>
                        </div>
                      </div>
                      {bank.code && <span className="text-xs font-mono text-muted-foreground shrink-0">{bank.code}</span>}
                    </div>
                    <div className="flex gap-5 text-sm border-t border-border/50 pt-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Base APR</div>
                        <div className="text-primary font-semibold">{bank.baseApr != null ? `${bank.baseApr}%` : "—"}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Max Term</div>
                        <div className="font-semibold">{bank.maxTermMonths != null ? `${bank.maxTermMonths} mo` : "—"}</div>
                      </div>
                      <div className="ml-auto text-right text-xs text-muted-foreground space-y-0.5 min-w-0">
                        {bank.contactPhone && <div className="truncate">{bank.contactPhone}</div>}
                        {bank.contactEmail && <div className="truncate">{bank.contactEmail}</div>}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
          )}
        </div>
      )}

      {tab === "invoices" && (
        <div className="space-y-4">
          <div className="flex justify-end gap-2">
            <CreateRecordDialog
              title="New Invoice"
              description="Issue an invoice to a customer."
              pending={createInvoice.isPending}
              submitLabel="Issue invoice"
              trigger={
                <Button variant="outline" size="sm" className="rounded-full gap-1.5 border-white/15 h-9">
                  <Plus className="w-4 h-4" /> New Invoice
                </Button>
              }
              fields={[
                { name: "customerName", label: "Customer", type: "text", required: true, span: "full" },
                {
                  name: "kind", label: "Kind", type: "select", span: "half", defaultValue: "final",
                  options: [
                    { value: "reservation", label: "Reservation (deposit)" },
                    { value: "final", label: "Final (balance)" },
                  ],
                },
                {
                  name: "dealId", label: "Linked deal (optional)", type: "select", span: "half",
                  options: (deals ?? [])
                    .filter((d) => d.stage === "desking" || d.stage === "committed")
                    .map((d) => ({
                      value: String(d.id),
                      label: `Deal #${d.id} — ${d.customerName ?? "Unknown"} (${money(d.otdPrice)})`,
                    })),
                },
                { name: "amount", label: "Amount", type: "number", required: true, span: "half" },
                { name: "dueDate", label: "Due date", type: "date", span: "half" },
                { name: "description", label: "Description", type: "textarea", span: "full", placeholder: "Reservation deposit, vehicle balance, accessories, service…" },
              ]}
              onSubmit={async (values) => {
                const v = values as Record<string, unknown>;
                const payload: InvoiceInput = {
                  customerName: v.customerName as string,
                  amount: Number(v.amount),
                  kind: (v.kind as InvoiceInput["kind"]) || "final",
                  dealId: v.dealId ? Number(v.dealId) : undefined,
                  dueDate: (v.dueDate as string) || undefined,
                  description: (v.description as string) || undefined,
                };
                await createInvoice.mutateAsync({ data: payload });
                queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListOutstandingBalancesQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
                toast({
                  title: "Invoice issued",
                  description:
                    payload.kind === "reservation" && payload.dealId
                      ? "Once this reservation invoice is fully paid, the deal's deposit requirement is satisfied."
                      : undefined,
                });
              }}
            />
            <CreateRecordDialog
              title="Record Payment"
              description="Record a payment against an open invoice — a receipt is issued automatically."
              pending={createPayment.isPending}
              submitLabel="Record payment"
              trigger={
                <Button size="sm" className="bg-primary hover:bg-primary/90 text-white rounded-full gap-1.5 h-9">
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
                const payload = {
                  invoiceId: Number(v.invoiceId),
                  amount: Number(v.amount),
                  method: v.method as PaymentInput["method"],
                  reference: (v.reference as string) || undefined,
                };
                try {
                  await createPayment.mutateAsync({ data: payload });
                } catch (err: unknown) {
                  const apiErr = err as { status?: number; data?: { error?: string } };
                  if (
                    apiErr.status === 409 &&
                    apiErr.data?.error === "duplicate_reference" &&
                    window.confirm(
                      "A payment with this reference already exists for this dealership. Record it again as a separate payment?",
                    )
                  ) {
                    await createPayment.mutateAsync({ data: { ...payload, confirmDuplicate: true } });
                  } else {
                    throw err;
                  }
                }
                queryClient.invalidateQueries({ queryKey: getListPaymentsQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListReceiptsQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListOutstandingBalancesQueryKey() });
                toast({ title: "Payment recorded", description: "A receipt was issued automatically." });
              }}
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-3">Invoices</h3>
              <div className="space-y-3">
                {invoices?.length === 0 && <p className="text-sm text-muted-foreground italic">No invoices yet.</p>}
                {invoices?.map((inv) => (
                  <button
                    key={inv.id}
                    type="button"
                    onClick={() => setInvoiceId(inv.id)}
                    className="w-full text-left glass-panel rounded-2xl px-4 py-3 flex items-center gap-4 hover:border-primary/40 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold flex items-center gap-2">
                        {inv.customerName}
                        <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${
                          inv.kind === "reservation"
                            ? "bg-sky-500/15 text-sky-400"
                            : "bg-primary/10 text-primary"
                        }`}>
                          {inv.kind === "reservation" ? "Reservation" : "Final"}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">{inv.invoiceNumber}{inv.description ? ` · ${inv.description}` : ""}</div>
                      {(inv.taxLines ?? []).length > 0 && (
                        <div className="text-[10px] text-muted-foreground mt-1">
                          Taxes: {(inv.taxLines ?? []).map((t) => `${t.name} ${money(t.amount)}`).join(" · ")}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-light text-lg">{money(inv.amount)}</div>
                      <Badge className={`border-none rounded-full text-[9px] font-bold uppercase tracking-widest ${
                        inv.status === "paid" ? "bg-emerald-500/15 text-emerald-400"
                          : inv.status === "partially_paid" ? "bg-amber-500/15 text-amber-400"
                          : inv.status === "void" ? "bg-foreground/10 text-muted-foreground"
                          : "bg-violet-500/15 text-violet-400"
                      }`}>
                        {inv.status.replace("_", " ")}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-3">Payments</h3>
              <div className="space-y-3">
                {payments?.length === 0 && <p className="text-sm text-muted-foreground italic">No payments recorded yet.</p>}
                {payments?.map((p) => (
                  <div key={p.id} className="glass-panel rounded-2xl px-4 py-3 flex items-center gap-4">
                    <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <CreditCard className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{p.customerName}</div>
                      <div className="text-xs text-muted-foreground uppercase tracking-widest">{p.method.replace("_", " ")}{p.reference ? ` · ${p.reference}` : ""}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-light text-lg text-primary">{money(p.amount)}</div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-widest">{formatGuyanaDate(p.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "receipts" && (
        <div className="space-y-2.5 max-w-3xl">
          {receipts?.length === 0 && <p className="text-sm text-muted-foreground italic">No receipts issued yet — receipts are generated automatically when payments are recorded.</p>}
          {receipts?.map((r) => (
            <button
              key={r.id}
              onClick={() => setReceiptId(r.id)}
              className="w-full text-left glass-panel rounded-2xl px-4 py-3 flex items-center gap-4 hover:border-primary/40 transition-colors"
            >
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
                  {r.method.replace("_", " ")} · {formatGuyanaDate(r.createdAt)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <ReceiptDetailDialog receiptId={receiptId} onClose={() => setReceiptId(null)} />
      <InvoiceDetailDialog
        invoice={invoices?.find((i) => i.id === invoiceId) ?? null}
        outstanding={outstanding?.find((o) => o.invoiceId === invoiceId) ?? null}
        onClose={() => setInvoiceId(null)}
      />

      {tab === "outstanding" && (
        <div className="space-y-2.5 max-w-4xl">
          {outstanding?.length === 0 && <p className="text-sm text-muted-foreground italic">Nothing outstanding — all invoices are settled.</p>}
          {outstanding?.map((o) => {
            const pct = o.amount > 0 ? Math.min((o.paidAmount / o.amount) * 100, 100) : 0;
            return (
              <div key={o.invoiceId} className="glass-panel rounded-2xl px-4 py-3">
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
    </>
  );
}

function InvoiceDetailDialog({
  invoice,
  outstanding,
  onClose,
}: {
  invoice: Invoice | null;
  outstanding: OutstandingBalance | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rawMoney = useMoney();
  const money = (n: number) => rawMoney.gyd(n);
  const createPayment = useCreatePayment();

  const balance = outstanding
    ? outstanding.balance
    : invoice && invoice.status !== "paid" && invoice.status !== "void"
      ? invoice.amount
      : 0;
  const payable =
    !!invoice && (invoice.status === "issued" || invoice.status === "partially_paid");

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentInput["method"]>("bank_transfer");
  const [reference, setReference] = useState("");
  const [showPay, setShowPay] = useState(false);
  useEffect(() => {
    if (invoice) {
      setAmount(balance > 0 ? String(Math.round(balance)) : "");
      setMethod("bank_transfer");
      setReference("");
      setShowPay(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id]);

  const submitPayment = async () => {
    if (!invoice) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    const payload = {
      invoiceId: invoice.id,
      amount: amt,
      method,
      reference: reference || undefined,
    };
    try {
      try {
        await createPayment.mutateAsync({ data: payload });
      } catch (err: unknown) {
        const apiErr = err as { status?: number; data?: { error?: string } };
        if (
          apiErr.status === 409 &&
          apiErr.data?.error === "duplicate_reference" &&
          window.confirm(
            "A payment with this reference already exists for this dealership. Record it again as a separate payment?",
          )
        ) {
          await createPayment.mutateAsync({ data: { ...payload, confirmDuplicate: true } });
        } else {
          throw err;
        }
      }
      queryClient.invalidateQueries({ queryKey: getListPaymentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListReceiptsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListOutstandingBalancesQueryKey() });
      toast({ title: "Payment recorded", description: "A receipt was issued automatically." });
      onClose();
    } catch (err: unknown) {
      const apiErr = err as { data?: { error?: string }; message?: string };
      toast({
        title: "Could not record payment",
        description: apiErr.data?.error ?? apiErr.message ?? "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={invoice != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary" />
            {invoice?.invoiceNumber ?? "Invoice"}
          </DialogTitle>
        </DialogHeader>
        {invoice && (
          <div className="space-y-4">
            <div className="text-center py-4 border-y border-border/50">
              <div className="text-3xl font-light tracking-tight">{money(invoice.amount)}</div>
              {balance > 0 && balance < invoice.amount && (
                <div className="text-xs text-muted-foreground mt-1">
                  {money(invoice.amount - balance)} paid · {money(balance)} due
                </div>
              )}
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Customer</span>
                <span className="font-medium">{invoice.customerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Kind</span>
                <span className="capitalize">{invoice.kind}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Status</span>
                <span className="capitalize">{invoice.status.replace(/_/g, " ")}</span>
              </div>
              {invoice.dueDate && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs">Due date</span>
                  <span>{invoice.dueDate}</span>
                </div>
              )}
              {invoice.description && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs shrink-0">Description</span>
                  <span className="text-right break-words min-w-0">{invoice.description}</span>
                </div>
              )}
              {(invoice.taxLines ?? []).map((t) => (
                <div key={t.name} className="flex justify-between">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs">{t.name}</span>
                  <span>{money(t.amount)}</span>
                </div>
              ))}
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Issued</span>
                <span>{formatGuyanaDate(invoice.createdAt)}</span>
              </div>
            </div>

            {payable && !showPay && (
              <Button
                className="w-full bg-primary hover:bg-primary/90 text-white rounded-full h-10 gap-1.5"
                onClick={() => setShowPay(true)}
              >
                <Plus className="w-4 h-4" /> Record Payment
              </Button>
            )}
            {payable && showPay && (
              <div className="space-y-3 rounded-2xl border border-border/60 p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                      Amount (GYD)
                    </label>
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full h-10 rounded-md border border-border/60 bg-transparent px-3 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/40"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                      Method
                    </label>
                    <StyledSelect
                      value={method}
                      onValueChange={(value) => setMethod(value as PaymentInput["method"])}
                      options={[
                        { value: "cash", label: "Cash" },
                        { value: "card", label: "Card" },
                        { value: "bank_transfer", label: "Bank Transfer" },
                        { value: "cheque", label: "Cheque" },
                        { value: "mobile_money", label: "Mobile Money" },
                        { value: "financing", label: "Financing" },
                      ]}
                      className="w-full h-10 rounded-md border border-border/60 bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    Reference (optional)
                  </label>
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Transfer / cheque number"
                    className="w-full h-10 rounded-md border border-border/60 bg-transparent px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </div>
                <Button
                  className="w-full bg-primary hover:bg-primary/90 text-white rounded-full h-10"
                  disabled={createPayment.isPending}
                  onClick={submitPayment}
                >
                  {createPayment.isPending ? "Recording…" : `Record ${amount ? money(Number(amount) || 0) : "payment"}`}
                </Button>
              </div>
            )}
            {!payable && invoice.status === "paid" && (
              <p className="text-xs text-muted-foreground text-center">
                This invoice is fully paid — see the Receipts tab for the receipt.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReceiptDetailDialog({
  receiptId,
  onClose,
}: {
  receiptId: number | null;
  onClose: () => void;
}) {
  const { data: receipt } = useGetReceipt(receiptId ?? 0, {
    query: { enabled: receiptId != null, queryKey: ["receipt-detail", receiptId] },
  });

  return (
    <Dialog open={receiptId != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ReceiptIcon className="w-4 h-4 text-emerald-400" />
            {receipt?.receiptNumber ?? "Receipt"}
          </DialogTitle>
        </DialogHeader>
        {receipt && (
          <div className="space-y-4">
            <div className="text-center py-4 border-y border-border/50">
              <div className="text-3xl font-light tracking-tight">
                GY${Math.round(receipt.amount).toLocaleString("en-US")}
              </div>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Customer</span>
                <span className="font-medium">{receipt.customerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Invoice</span>
                <span className="font-mono text-xs">{receipt.invoiceNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Method</span>
                <span className="capitalize">{receipt.method.replace(/_/g, " ")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground uppercase tracking-wider text-xs">Issued</span>
                <span>{formatGuyanaDate(receipt.createdAt)}</span>
              </div>
              {receipt.issuedBy && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs">Issued by</span>
                  <span>{receipt.issuedBy}</span>
                </div>
              )}
            </div>
            <a
              href={`${import.meta.env.BASE_URL}api/receipts/${receipt.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 h-10 rounded-full border border-border/60 text-sm font-medium hover:bg-muted/40 transition-colors"
            >
              <FileText className="w-4 h-4" /> Download Receipt PDF
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
