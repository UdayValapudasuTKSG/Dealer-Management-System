import {
  useCreateInvoice,
  useCreatePayment,
  useListPayments,
  getListDealsQueryKey,
  getListInvoicesQueryKey,
  getListPaymentsQueryKey,
  getListReceiptsQueryKey,
  getListOutstandingBalancesQueryKey,
} from "@workspace/api-client-react";
import type {
  Deal,
  Invoice,
  OutstandingBalance,
  InvoiceInput,
  PaymentInput,
} from "@workspace/api-client-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useMoney } from "@/lib/format";

/**
 * Quick finance actions against a deal — issue an invoice (reservation or
 * final) and record a payment — without leaving the page the deal is shown
 * on. Rendered as controlled dialogs; the host page provides the trigger
 * buttons and passes the target deal when one is chosen.
 */

export function openInvoicesForDeal(
  invoices: Invoice[] | undefined,
  dealId: number,
): Invoice[] {
  return (invoices ?? []).filter(
    (inv) =>
      inv.dealId === dealId &&
      (inv.status === "issued" || inv.status === "partially_paid"),
  );
}

export function paidForDeal(
  invoices: Invoice[] | undefined,
  outstandingBalances: OutstandingBalance[] | undefined,
  dealId: number,
): number {
  return (invoices ?? [])
    .filter((inv) => inv.dealId === dealId && inv.status !== "void")
    .reduce((sum, inv) => {
      if (inv.status === "paid") return sum + inv.amount;
      const o = (outstandingBalances ?? []).find(
        (x) => x.invoiceId === inv.id,
      );
      return sum + (o?.paidAmount ?? 0);
    }, 0);
}

const STATUS_STYLE: Record<string, string> = {
  paid: "text-emerald-400",
  partially_paid: "text-amber-400",
  issued: "text-sky-400",
  void: "text-muted-foreground line-through",
};

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  bank_transfer: "Bank Transfer",
  cheque: "Cheque",
  mobile_money: "Mobile Money",
  financing: "Financing",
};

/**
 * Compact read-only list of a deal's invoices and their payments — shown
 * wherever the deal is displayed so users don't have to open Finance.
 */
export function DealFinanceRecords({
  dealId,
  invoices,
  outstandingBalances,
}: {
  dealId: number;
  invoices: Invoice[] | undefined;
  outstandingBalances: OutstandingBalance[] | undefined;
}) {
  const money = useMoney();
  const { data: payments } = useListPayments();
  const dealInvoices = (invoices ?? []).filter((inv) => inv.dealId === dealId);
  if (dealInvoices.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No invoices issued for this deal yet.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {dealInvoices.map((inv) => {
        const o = (outstandingBalances ?? []).find(
          (x) => x.invoiceId === inv.id,
        );
        const paid =
          inv.status === "paid" ? inv.amount : (o?.paidAmount ?? 0);
        const invPayments = (payments ?? []).filter(
          (p) => p.invoiceId === inv.id,
        );
        return (
          <div
            key={inv.id}
            className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-xs font-semibold">
                {inv.invoiceNumber}
                <span className="ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                  {inv.kind === "reservation" ? "Reservation" : "Final"}
                </span>
              </div>
              <div
                className={`text-[10px] uppercase tracking-widest font-semibold ${
                  STATUS_STYLE[inv.status] ?? "text-muted-foreground"
                }`}
              >
                {inv.status.replace("_", " ")}
              </div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {money.gyd(inv.amount)}
              {inv.status !== "void" && (
                <> · paid {money.gyd(paid)}</>
              )}
              {inv.dueDate && <> · due {inv.dueDate.slice(0, 10)}</>}
            </div>
            {invPayments.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-white/10 pt-2">
                {invPayments.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-muted-foreground">
                      {p.createdAt.slice(0, 10)} ·{" "}
                      {METHOD_LABEL[p.method] ?? p.method}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </span>
                    <span className="font-medium">{money.gyd(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

type Props = {
  /** Deal to issue an invoice for (dialog open while non-null). */
  invoiceDeal: Deal | null;
  /** Deal to record a payment against (dialog open while non-null). */
  paymentDeal: Deal | null;
  onCloseInvoice: () => void;
  onClosePayment: () => void;
  invoices: Invoice[] | undefined;
  outstandingBalances: OutstandingBalance[] | undefined;
  /** Extra cache invalidation after either action (page-specific keys). */
  onDone?: () => void;
  /**
   * Called right after an invoice is issued so the host can open the payment
   * dialog for the same deal — issuing an invoice does NOT record money
   * received; chaining the two steps prevents "I thought I paid" confusion.
   */
  onRequestPayment?: (deal: Deal) => void;
};

export function DealQuickFinanceDialogs({
  invoiceDeal,
  paymentDeal,
  onCloseInvoice,
  onClosePayment,
  invoices,
  outstandingBalances,
  onDone,
  onRequestPayment,
}: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const money = useMoney();
  const createInvoice = useCreateInvoice();
  const createPayment = useCreatePayment();
  // Kind currently selected in the invoice dialog — a reservation fee is paid
  // on the spot, so its date field is a plain "Date" prefilled with today.
  const [invoiceKind, setInvoiceKind] = useState<string>("final");
  useEffect(() => {
    if (invoiceDeal) setInvoiceKind("final");
  }, [invoiceDeal]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListPaymentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListReceiptsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getListOutstandingBalancesQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
    onDone?.();
  };

  const remaining = (deal: Deal) =>
    Math.max(
      Math.round(
        (deal.otdPrice - paidForDeal(invoices, outstandingBalances, deal.id)) *
          100,
      ) / 100,
      0,
    );

  const outstandingFor = (inv: Invoice) => {
    const o = (outstandingBalances ?? []).find((x) => x.invoiceId === inv.id);
    return o ? inv.amount - (o.paidAmount ?? 0) : inv.amount;
  };

  return (
    <>
      {invoiceDeal && (
        <CreateRecordDialog
          title={`New invoice — ${invoiceDeal.customerName || "Unknown Customer"}`}
          description={`Issued against Deal #${invoiceDeal.id} and visible in Finance too.`}
          open
          onOpenChange={(o) => !o && onCloseInvoice()}
          pending={createInvoice.isPending}
          submitLabel="Issue invoice"
          trigger={<span className="hidden" />}
          fields={[
            {
              name: "kind",
              label: "Kind",
              type: "select",
              span: "half",
              defaultValue: "final",
              options: [
                { value: "reservation", label: "Reservation (deposit)" },
                { value: "final", label: "Final (balance)" },
              ],
              onChange: (value, setField) => {
                setInvoiceKind(value);
                if (value === "reservation") {
                  // Reservation fees are paid on the spot — prefill today.
                  setField("dueDate", new Date().toISOString().slice(0, 10));
                } else {
                  setField("dueDate", "");
                }
              },
            },
            {
              name: "amount",
              label: "Amount (GYD)",
              type: "number",
              required: true,
              span: "half",
              min: 1,
              defaultValue: remaining(invoiceDeal)
                ? String(remaining(invoiceDeal))
                : undefined,
            },
            {
              name: "dueDate",
              label: invoiceKind === "reservation" ? "Date" : "Due date",
              type: "date",
              span: "half",
            },
            {
              name: "description",
              label: "Description",
              type: "textarea",
              span: "full",
              placeholder: "Reservation deposit, vehicle balance, accessories…",
            },
          ]}
          onSubmit={async (values) => {
            const v = values as Record<string, unknown>;
            const payload: InvoiceInput = {
              customerName: invoiceDeal.customerName || "Unknown Customer",
              customerId: invoiceDeal.customerId ?? undefined,
              dealId: invoiceDeal.id,
              amount: Number(v.amount),
              kind: (v.kind as InvoiceInput["kind"]) || "final",
              dueDate: (v.dueDate as string) || undefined,
              description: (v.description as string) || undefined,
            };
            const dealForPayment = invoiceDeal;
            await createInvoice.mutateAsync({ data: payload });
            refresh();
            onCloseInvoice();
            toast({
              title: "Invoice issued — payment NOT yet recorded",
              description:
                payload.kind === "reservation"
                  ? "Now record the money received. The reservation fee only shows as paid once the payment is recorded."
                  : "Now record the money received — an invoice alone doesn't mark anything as paid.",
            });
            onRequestPayment?.(dealForPayment);
          }}
        />
      )}

      {paymentDeal && (
        <CreateRecordDialog
          title={`Record payment — ${paymentDeal.customerName || "Unknown Customer"}`}
          description={`Against an open invoice on Deal #${paymentDeal.id} — a receipt is issued automatically.`}
          open
          onOpenChange={(o) => !o && onClosePayment()}
          pending={createPayment.isPending}
          submitLabel="Record payment"
          trigger={<span className="hidden" />}
          fields={[
            {
              name: "invoiceId",
              label: "Invoice",
              type: "select",
              required: true,
              span: "full",
              defaultValue:
                openInvoicesForDeal(invoices, paymentDeal.id).length === 1
                  ? String(openInvoicesForDeal(invoices, paymentDeal.id)[0].id)
                  : undefined,
              options: openInvoicesForDeal(invoices, paymentDeal.id).map(
                (inv) => ({
                  value: String(inv.id),
                  label: `${inv.invoiceNumber} — ${
                    inv.kind === "reservation" ? "Reservation" : "Final"
                  } (${money.gyd(outstandingFor(inv))} due)`,
                }),
              ),
            },
            {
              name: "amount",
              label: "Amount (GYD)",
              type: "number",
              required: true,
              span: "half",
              min: 1,
              defaultValue: (() => {
                const open = openInvoicesForDeal(invoices, paymentDeal.id);
                if (open.length !== 1) return undefined;
                const due = outstandingFor(open[0]);
                return due > 0 ? String(due) : undefined;
              })(),
            },
            {
              name: "method",
              label: "Method",
              type: "select",
              required: true,
              span: "half",
              defaultValue: "bank_transfer",
              options: [
                { value: "cash", label: "Cash" },
                { value: "card", label: "Card" },
                { value: "bank_transfer", label: "Bank Transfer" },
                { value: "cheque", label: "Cheque" },
                { value: "mobile_money", label: "Mobile Money" },
                { value: "financing", label: "Financing" },
              ],
            },
            {
              name: "reference",
              label: "Reference",
              type: "text",
              span: "full",
              placeholder: "Transfer / cheque number",
            },
          ]}
          onSubmit={async (values) => {
            const v = values as Record<string, unknown>;
            const payload: PaymentInput = {
              invoiceId: Number(v.invoiceId),
              amount: Number(v.amount),
              method: v.method as PaymentInput["method"],
              reference: (v.reference as string) || undefined,
            };
            try {
              await createPayment.mutateAsync({ data: payload });
            } catch (err: unknown) {
              const apiErr = err as {
                status?: number;
                data?: { error?: string };
              };
              if (
                apiErr.status === 409 &&
                apiErr.data?.error === "duplicate_reference" &&
                window.confirm(
                  "A payment with this reference already exists for this dealership. Record it again as a separate payment?",
                )
              ) {
                await createPayment.mutateAsync({
                  data: { ...payload, confirmDuplicate: true },
                });
              } else {
                throw err;
              }
            }
            refresh();
            onClosePayment();
            toast({
              title: "Payment recorded",
              description: "A receipt was issued automatically.",
            });
          }}
        />
      )}
    </>
  );
}
