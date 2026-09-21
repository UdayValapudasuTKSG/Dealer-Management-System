import { useState } from "react";
import {
  getListPartsPurchaseOrderReviewQueueQueryKey,
  useApprovePartsSupplierEmail,
  useAssignPartsPurchaseOrderSupplier,
  useCreatePartsSpecialOrder,
  useGeneratePartsLowStockPurchaseOrders,
  useListJobCards,
  useListLeadAdvisors,
  useListPartsLocations,
  useListPartsPurchaseOrderReviewQueue,
  useListParts,
  useListSuppliers,
  type PurchaseOrder,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatGuyanaDate, useMoney } from "@/lib/format";
import { useAuthz } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AlertTriangle, Clock, Inbox, Loader2, MapPin, Plus, RefreshCw, Send, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "The request could not be completed.";
}

type PurchaseOrderSourceFilter = "" | "low_stock_alert" | "special_order" | "manual";
const SOURCE_FILTERS: { id: PurchaseOrderSourceFilter; label: string }[] = [
  { id: "", label: "All Drafts" },
  { id: "low_stock_alert", label: "Auto-Replenish" },
  { id: "special_order", label: "Special Orders" },
  { id: "manual", label: "Manual" },
];

export function POReviewTab() {
  const [sourceFilter, setSourceFilter] = useState<PurchaseOrderSourceFilter>("");
  const params = sourceFilter ? { source: sourceFilter } : undefined;
  const { data: queue, isLoading, isError, error, refetch } =
    useListPartsPurchaseOrderReviewQueue(params);

  if (isLoading) return <div className="h-64 rounded-3xl bg-white/[0.05] animate-pulse" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div className="flex flex-wrap gap-2">
          {SOURCE_FILTERS.map((filter) => (
            <Button
              key={filter.id}
              variant={sourceFilter === filter.id ? "default" : "outline"}
              size="sm"
              className={cn("h-8 rounded-full text-xs", sourceFilter !== filter.id && "border-white/10")}
              onClick={() => setSourceFilter(filter.id)}
              data-testid={`button-po-filter-${filter.id || "all"}`}
            >
              {filter.label}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <GenerateOrdersDialog />
          <SpecialOrderDialog />
        </div>
      </div>

      {isError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          {errorMessage(error)}
          <Button variant="outline" size="sm" className="ml-3" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : !queue?.length ? (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20">
          <Inbox className="h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground">No draft purchase orders pending review.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {queue.map((po) => <POReviewCard key={po.id} po={po} />)}
        </div>
      )}
    </div>
  );
}

function GenerateOrdersDialog() {
  const [open, setOpen] = useState(false);
  const [locationId, setLocationId] = useState("");
  const { data: locations } = useListPartsLocations();
  const generate = useGeneratePartsLowStockPurchaseOrders();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const submit = async () => {
    if (!locationId) {
      toast({ title: "Select a location", variant: "destructive" });
      return;
    }
    try {
      await generate.mutateAsync({ data: { locationId: Number(locationId) } });
      await queryClient.invalidateQueries({ queryKey: ["/api/parts/operations/purchase-orders"] });
      toast({ title: "Replenishment review complete", description: "Any required orders were saved as drafts for review." });
      setOpen(false);
    } catch (error) {
      toast({ title: "Could not generate draft orders", description: errorMessage(error), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full gap-2" data-testid="button-open-auto-po">
          <Sparkles className="h-4 w-4" /> Auto-generate
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate replenishment drafts</DialogTitle>
          <DialogDescription>
            Review stock targets for one location. This creates drafts only and never contacts suppliers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Destination location</Label>
          <StyledSelect
            value={locationId}
            onValueChange={setLocationId}
            options={[
              { value: "", label: "Select location…" },
              ...(locations ?? []).filter((location) => location.active).map((location) => ({
                value: String(location.id),
                label: location.name,
              })),
            ]}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={generate.isPending}>
            {generate.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Generate drafts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SpecialOrderDialog() {
  const [open, setOpen] = useState(false);
  const [partId, setPartId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [referenceType, setReferenceType] = useState<"job" | "estimate">("job");
  const [referenceId, setReferenceId] = useState("");
  const [advisorId, setAdvisorId] = useState("");
  const { data: parts } = useListParts();
  const { data: locations } = useListPartsLocations();
  const { data: advisors } = useListLeadAdvisors();
  const { data: jobs } = useListJobCards();
  const create = useCreatePartsSpecialOrder();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const reset = () => {
    setPartId("");
    setLocationId("");
    setQuantity("1");
    setReferenceType("job");
    setReferenceId("");
    setAdvisorId("");
  };

  const submit = async () => {
    const parsedQuantity = Number(quantity);
    if (!partId || !locationId || !advisorId || !referenceId || !Number.isSafeInteger(parsedQuantity) || parsedQuantity < 1) {
      toast({ title: "Complete every required field", description: "Quantity and all selected IDs must be valid.", variant: "destructive" });
      return;
    }
    try {
      await create.mutateAsync({
        data: {
          partId: Number(partId),
          locationId: Number(locationId),
          quantity: parsedQuantity,
          referenceType,
          referenceId: Number(referenceId),
          advisorId: Number(advisorId),
          idempotencyKey: crypto.randomUUID(),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/parts/operations/purchase-orders"] });
      toast({ title: "Special-order draft created", description: "Assign a supplier and approve it from the review queue." });
      setOpen(false);
      reset();
    } catch (error) {
      toast({ title: "Could not create special order", description: errorMessage(error), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="rounded-full gap-2" data-testid="button-open-special-order">
          <Plus className="h-4 w-4" /> Special order
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create a special-order draft</DialogTitle>
          <DialogDescription>Link the required part to an existing workshop job or job-card estimate.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Part</Label>
            <StyledSelect value={partId} onValueChange={setPartId} options={[
              { value: "", label: "Select part…" },
              ...(parts ?? []).map((part) => ({ value: String(part.id), label: `${part.sku} — ${part.name}` })),
            ]} />
          </div>
          <div className="space-y-2">
            <Label>Destination location</Label>
            <StyledSelect value={locationId} onValueChange={setLocationId} options={[
              { value: "", label: "Select location…" },
              ...(locations ?? []).filter((location) => location.active).map((location) => ({ value: String(location.id), label: location.name })),
            ]} />
          </div>
          <div className="space-y-2">
            <Label>Quantity</Label>
            <Input type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Reference type</Label>
            <StyledSelect
              value={referenceType}
              onValueChange={(value) => {
                setReferenceType(value as "job" | "estimate");
                setReferenceId("");
              }}
              options={[
                { value: "job", label: "Workshop job" },
                { value: "estimate", label: "Job-card estimate" },
              ]}
            />
          </div>
          <div className="space-y-2">
            <Label>{referenceType === "job" ? "Workshop job" : "Estimate ID"}</Label>
            {referenceType === "job" ? (
              <StyledSelect value={referenceId} onValueChange={setReferenceId} options={[
                { value: "", label: "Select job…" },
                ...(jobs ?? []).map((job) => ({ value: String(job.id), label: `#${job.id} — ${job.title}` })),
              ]} />
            ) : (
              <Input type="number" min={1} step={1} value={referenceId} onChange={(event) => setReferenceId(event.target.value)} placeholder="Existing estimate ID" />
            )}
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Responsible advisor</Label>
            <StyledSelect value={advisorId} onValueChange={setAdvisorId} options={[
              { value: "", label: "Select advisor…" },
              ...(advisors ?? []).map((advisor) => ({ value: String(advisor.id), label: advisor.name })),
            ]} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function POReviewCard({ po }: { po: PurchaseOrder }) {
  const { toast } = useToast();
  const { can } = useAuthz();
  const queryClient = useQueryClient();
  const assign = useAssignPartsPurchaseOrderSupplier();
  const send = useApprovePartsSupplierEmail();
  const { data: suppliers } = useListSuppliers();
  const { data: locations } = useListPartsLocations();
  const money = useMoney();
  const [assignOpen, setAssignOpen] = useState(false);
  const [supplierId, setSupplierId] = useState(po.supplierId ? String(po.supplierId) : "");
  const [confirmAction, setConfirmAction] = useState<"send" | "resend" | null>(null);
  const mayApprove = can("parts", "approve");

  const handleAssign = async () => {
    if (!supplierId) {
      toast({ title: "Select a supplier", variant: "destructive" });
      return;
    }
    try {
      await assign.mutateAsync({ id: po.id, data: { supplierId: Number(supplierId) } });
      await queryClient.invalidateQueries({ queryKey: getListPartsPurchaseOrderReviewQueueQueryKey() });
      toast({ title: "Supplier assigned" });
      setAssignOpen(false);
    } catch (error) {
      toast({ title: "Could not assign supplier", description: errorMessage(error), variant: "destructive" });
    }
  };

  const handleSend = async () => {
    const resend = confirmAction === "resend";
    if (!po.supplierId || po.needsSupplier) {
      toast({ title: "Supplier required", description: "Assign a supplier before sending.", variant: "destructive" });
      return;
    }
    try {
      await send.mutateAsync({ id: po.id, data: resend ? { confirm: true, resend: true } : { confirm: true } });
      await queryClient.invalidateQueries({ queryKey: getListPartsPurchaseOrderReviewQueueQueryKey() });
      toast({ title: resend ? "Supplier email re-queued" : "Supplier email queued", description: "Delivery status is tracked in the Outbox." });
      setConfirmAction(null);
    } catch (error) {
      toast({ title: resend ? "Could not re-queue PO" : "Could not send PO", description: errorMessage(error), variant: "destructive" });
    }
  };

  const supplierName = suppliers?.find((supplier) => supplier.id === po.supplierId)?.name;
  const locationName = locations?.find((location) => location.id === po.locationId)?.name;
  return (
    <>
      <Card className={cn("glass-panel overflow-hidden rounded-2xl border-none", po.source === "special_order" && "ring-1 ring-amber-500/50", po.needsSupplier && "ring-1 ring-rose-500/50")}>
        <CardContent className="flex flex-col p-0 md:flex-row">
          <div className="flex-1 space-y-4 p-5">
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <Badge variant="outline" className="border-white/10 bg-white/[0.05] font-mono text-[10px] uppercase">PO #{po.id}</Badge>
                <Badge variant="secondary" className="border-none text-[10px] uppercase tracking-widest">
                  {po.source.replaceAll("_", " ")}
                </Badge>
              </div>
              <h3 className="text-lg font-bold">
                {po.needsSupplier ? <span className="flex items-center gap-2 text-rose-400"><AlertTriangle className="h-4 w-4" /> Supplier needed</span> : supplierName ?? `Supplier #${po.supplierId}`}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Created {formatGuyanaDate(po.createdAt)}</span>
                {po.locationId && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> {locationName ?? `Location #${po.locationId}`}</span>}
              </div>
            </div>
            <div className="overflow-hidden rounded-xl bg-black/20">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-white/5 text-left uppercase tracking-wider text-muted-foreground"><th className="px-3 py-2">Part</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Est. cost</th></tr></thead>
                <tbody>
                  {po.lines.map((line) => (
                    <tr key={line.id} className="border-b border-white/5 last:border-0">
                      <td className="px-3 py-2 font-medium">{line.partName}</td>
                      <td className="px-3 py-2 text-right">{line.quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money.gyd(line.unitCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-col justify-center gap-3 border-t border-white/10 bg-white/[0.02] p-5 md:w-64 md:border-l md:border-t-0">
            <Button variant={po.needsSupplier ? "destructive" : "outline"} onClick={() => setAssignOpen(true)} disabled={assign.isPending}>
              {po.needsSupplier ? "Assign supplier" : "Change supplier"}
            </Button>
            {!po.needsSupplier && (
              <>
                <Button onClick={() => setConfirmAction("send")} disabled={send.isPending || !mayApprove} className="gap-2">
                  <Send className="h-4 w-4" /> Approve & send
                </Button>
                {po.sendCount > 0 && (
                  <Button variant="outline" onClick={() => setConfirmAction("resend")} disabled={send.isPending || !mayApprove} className="gap-2">
                    <RefreshCw className="h-3.5 w-3.5" /> Resend ({po.sendCount} sent)
                  </Button>
                )}
                {!mayApprove && <p className="text-center text-xs text-muted-foreground">Manager approval permission is required to send.</p>}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Assign supplier to PO #{po.id}</DialogTitle><DialogDescription>Confirm the vendor that will receive this purchase order.</DialogDescription></DialogHeader>
          <StyledSelect value={supplierId} onValueChange={setSupplierId} options={[
            { value: "", label: "Select supplier…" },
            ...(suppliers ?? []).map((supplier) => ({ value: String(supplier.id), label: supplier.name })),
          ]} />
          {!suppliers?.length && <p className="text-sm text-destructive">No suppliers are available. Add one from the Suppliers tab first.</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleAssign()} disabled={!supplierId || assign.isPending}>
              {assign.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Confirm supplier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction === "resend" ? "Resend this purchase order?" : "Approve and send this purchase order?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "resend"
                ? "This explicitly queues another supplier email. Check the Outbox first if the prior delivery status is uncertain."
                : `This queues PO #${po.id} for delivery to ${supplierName ?? "the assigned supplier"}. No stock is received by this action.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); void handleSend(); }} disabled={send.isPending}>
              {send.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}