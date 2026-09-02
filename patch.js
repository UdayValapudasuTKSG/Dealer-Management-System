const fs = require('fs');
const file = 'artifacts/aura/src/pages/service.tsx';
let content = fs.readFileSync(file, 'utf8');

const dialogCode = `
function BookingDetailsDialog({
  order,
  open,
  onOpenChange,
}: {
  order: ServiceOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const money = useMoney();

  if (!order) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            RO #{order.id.toString().padStart(5, "0")}
            <Badge
              variant="secondary"
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border-none shrink-0",
                order.status === "in_progress"
                  ? "bg-primary/15 text-primary"
                  : order.status === "resolved" || order.status === "closed"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-white/[0.06] text-foreground",
              )}
            >
              {order.status.replace(/_/g, " ")}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {order.vehicleInfo}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Customer
              </div>
              <div className="font-medium text-sm">
                {order.customerId ? (
                  <Link
                    href={\`/customers/\${order.customerId}\`}
                    className="text-primary hover:underline"
                    onClick={() => onOpenChange(false)}
                  >
                    {order.customerName || "Unknown"}
                  </Link>
                ) : (
                  <span>{order.customerName || "Unknown"}</span>
                )}
              </div>
              {order.customerPhoneSnapshot && (
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                  <Phone className="w-3 h-3" /> {order.customerPhoneSnapshot}
                </div>
              )}
            </div>
            
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Scheduled
              </div>
              <div className="font-medium text-sm">
                {formatCalendarDateShort(order.scheduledDate)}
              </div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mt-3 mb-1">
                Created
              </div>
              <div className="font-medium text-xs text-muted-foreground">
                {formatDealerDateShort(order.createdAt)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Service Type
              </div>
              <div className="font-medium text-sm capitalize">
                {order.type}
              </div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mt-3 mb-1">
                Pay Type
              </div>
              <div className="font-medium text-sm">
                {order.payType ? (PAY_TYPE_LABEL[order.payType] ?? order.payType) : "—"}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Technician
              </div>
              <div className="font-medium text-sm">
                {order.technician || <span className="text-muted-foreground italic">Unassigned</span>}
              </div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mt-3 mb-1">
                Odometer
              </div>
              <div className="font-medium text-sm">
                {order.odometer != null ? \`\${order.odometer.toLocaleString()} km\` : "—"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 bg-foreground/[0.02] p-4 rounded-xl border border-white/5">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Est. Total
              </div>
              <div className="font-medium text-lg tracking-tight text-primary">
                {money.gyd(order.estimatedCost)}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Est. Hours
              </div>
              <div className="font-medium text-sm">
                {order.estimatedHours ? \`\${order.estimatedHours}h\` : "—"}
              </div>
            </div>
          </div>

          {(order.jobs?.length > 0 || order.complaint) && (
            <div className="space-y-4 border-t border-white/10 pt-4">
              {order.jobs?.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-2">
                    Requested Jobs
                  </div>
                  <ul className="list-disc list-inside text-sm space-y-1 pl-4">
                    {order.jobs.map((job, i) => (
                      <li key={i} className="text-foreground/90">{job}</li>
                    ))}
                  </ul>
                </div>
              )}
              {order.complaint && (
                <div>
                  <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-2">
                    Customer Complaint / Notes
                  </div>
                  <div className="text-sm bg-white/[0.04] p-3 rounded-lg border border-white/5 whitespace-pre-wrap">
                    {order.complaint}
                  </div>
                </div>
              )}
            </div>
          )}

          {order.stageHistory && order.stageHistory.length > 0 && (
            <div className="border-t border-white/10 pt-4">
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-3">
                Stage History
              </div>
              <div className="space-y-4">
                {order.stageHistory.map((ev, i) => (
                  <div key={i} className="text-sm pl-2 border-l-2 border-white/10">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">{ev.byName}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDealerDayTime(new Date(ev.at))}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mb-1">
                      Moved from <span className="capitalize text-foreground/80">{ev.from.replace(/_/g, " ")}</span> to <span className="capitalize text-foreground/80">{ev.to.replace(/_/g, " ")}</span>
                    </div>
                    {ev.justification && (
                      <div className="text-xs bg-white/5 p-2 rounded italic">
                        "{ev.justification}"
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BookingsTab() {
  const [selectedOrder, setSelectedOrder] = useState<ServiceOrder | null>(null);`;

content = content.replace('function BookingsTab() {', dialogCode);


// Replace the tr interaction. I'll find the exact text in BookingsTab
const trBefore = `<tr
                  key={order.id}
                  id={\`service-order-\${order.id}\`}
                  className={\`border-b border-white/5 hover:bg-foreground/[0.03] transition-colors \${
                    isFocused(order.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : ""
                  }\`}
                >`;
const trAfter = `<tr
                  key={order.id}
                  id={\`service-order-\${order.id}\`}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('button, a, input, select, textarea, [role="button"]') !== null && target.closest('button, a, input, select, textarea, [role="button"]') !== e.currentTarget) return;
                    setSelectedOrder(order);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedOrder(order);
                    }
                  }}
                  className={\`border-b border-white/5 hover:bg-foreground/[0.03] transition-colors focus-visible:outline-none focus-visible:bg-foreground/[0.03] cursor-pointer \${
                    isFocused(order.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : ""
                  }\`}
                >`;
content = content.replace(trBefore, trAfter);

// Now for the card.
const cardBefore = `<Card className={\`glass-panel shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group relative \${
              isFocused(order.id) ? "border border-primary ring-2 ring-primary/50" : "border-none"
            }\`}>`;

const cardAfter = `<Card
              role="button"
              tabIndex={0}
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest('button, a, input, select, textarea, [role="button"]') !== null && target.closest('button, a, input, select, textarea, [role="button"]') !== e.currentTarget) return;
                setSelectedOrder(order);
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedOrder(order);
                }
              }}
              className={\`glass-panel shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 cursor-pointer \${
              isFocused(order.id) ? "border border-primary ring-2 ring-primary/50" : "border-none"
            }\`}>`;
content = content.replace(cardBefore, cardAfter);

// Add Dialog at the very end of BookingsTab
// Let's locate the end of BookingsTab.
// It ends with:
/*
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Job cards                                                           */
/* ------------------------------------------------------------------ */
*/

const endOfBookingsTab = `      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Job cards`;
const endOfBookingsTabAfter = `      </div>
    </div>
      <BookingDetailsDialog
        order={selectedOrder}
        open={!!selectedOrder}
        onOpenChange={(open) => !open && setSelectedOrder(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Job cards`;

content = content.replace(endOfBookingsTab, endOfBookingsTabAfter);

// And we need to wrap the return in <>
const returnListBefore = `  if (!isLoading && orders?.length !== 0 && layout === "list") {
    return (
      <div className="space-y-4">`;

const returnListAfter = `  if (!isLoading && orders?.length !== 0 && layout === "list") {
    return (
      <>
      <div className="space-y-4">`;

content = content.replace(returnListBefore, returnListAfter);

const returnListEndBefore = `          </table>
        </div>
      </div>
    );
  }`;
const returnListEndAfter = `          </table>
        </div>
      </div>
      <BookingDetailsDialog
        order={selectedOrder}
        open={!!selectedOrder}
        onOpenChange={(open) => !open && setSelectedOrder(null)}
      />
      </>
    );
  }`;
content = content.replace(returnListEndBefore, returnListEndAfter);

const returnGridBefore = `  return (
    <div className="space-y-4">`;
const returnGridAfter = `  return (
    <>
    <div className="space-y-4">`;
content = content.replace(returnGridBefore, returnGridAfter);

fs.writeFileSync(file, content);

