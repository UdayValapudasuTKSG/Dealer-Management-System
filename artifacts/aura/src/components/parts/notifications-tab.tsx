import { useState } from "react";
import { formatGuyanaDate } from "@/lib/format";
import { useGetNotifications, useGetNotificationSmsSettings, useRetryNotification } from "@/hooks/use-parts-operations";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Bell, AlertTriangle, CheckCircle2, MessageSquare, Mail, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

export function NotificationsTab() {
  const [statusFilter, setStatusFilter] = useState<string>("failed");
  const { data: notifications, isLoading } = useGetNotifications(statusFilter ? statusFilter : undefined);
  const { data: smsSettings } = useGetNotificationSmsSettings();

  if (isLoading) {
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  }

  return (
    <div className="space-y-6">
      {smsSettings?.ready === false && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-amber-500">SMS Sending Not Configured</h3>
            <p className="text-sm text-amber-500/80 mt-1">
              {smsSettings.reason ?? "SMS is not ready for this dealership. Internal notifications remain available."}
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <div className="flex gap-2">
          {[
            { id: "", label: "All Logs" },
            { id: "failed", label: "Failures" },
            { id: "pending", label: "Pending" },
            { id: "sent", label: "Sent" },
          ].map(filter => (
            <Button
              key={filter.id}
              variant={statusFilter === filter.id ? "default" : "outline"}
              size="sm"
              className={cn("rounded-full h-8 text-xs", statusFilter === filter.id ? "bg-primary hover:bg-primary/90 text-white" : "border-white/10")}
              onClick={() => setStatusFilter(filter.id)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </div>

      {!notifications?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
          <CheckCircle2 className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">No notifications found for this filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {notifications.map(notif => (
            <NotificationCard key={notif.id} notification={notif} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationCard({ notification: n }: { notification: any }) {
  const { toast } = useToast();
  const retry = useRetryNotification();
  
  const isFailed = n.status === "failed";
  const isPending = n.status === "pending";
  const isSent = n.status === "sent";

  let StatusIcon = Bell;
  if (isFailed) StatusIcon = XCircle;
  if (isPending) StatusIcon = RefreshCw;
  if (isSent) StatusIcon = CheckCircle2;

  const handleRetry = async () => {
    try {
      await retry.mutateAsync(n.id);
      toast({ title: "Retry triggered", description: "Notification queued for delivery." });
    } catch (error) {
      toast({ title: "Retry failed", description: error instanceof Error ? error.message : "Could not queue this notification.", variant: "destructive" });
    }
  };

  return (
    <div className={cn(
      "flex items-center justify-between p-4 rounded-2xl border transition-colors bg-white/[0.02]",
      isFailed ? "border-rose-500/20 bg-rose-500/5" : "border-white/5",
    )}>
      <div className="flex gap-4 items-start">
        <div className={cn(
          "w-10 h-10 rounded-full flex items-center justify-center shrink-0 border",
          isFailed ? "bg-rose-500/10 border-rose-500/20 text-rose-400" : 
          isSent ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : 
          "bg-white/[0.05] border-white/10 text-muted-foreground"
        )}>
          <StatusIcon className={cn("w-4 h-4", isPending && "animate-spin-slow")} />
        </div>
        
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{n.type.replace(/_/g, ' ')}</span>
            <Badge variant="outline" className="text-[10px] uppercase font-mono tracking-widest bg-transparent border-white/10 text-muted-foreground">
              {n.channel}
            </Badge>
            {n.referenceType && (
              <span className="text-xs text-muted-foreground">
                Ref: {n.referenceType} {n.referenceId}
              </span>
            )}
          </div>
          
          <div className="text-sm text-muted-foreground">
            {n.recipientId ? `Recipient #${n.recipientId}` : 'System'} 
            <span className="mx-2">•</span> 
            {formatGuyanaDate(n.createdAt)}
          </div>
          
          {isFailed && n.errorMessage && (
            <div className="text-xs text-rose-400 mt-2 bg-rose-500/10 px-2 py-1 rounded inline-block">
              {n.errorMessage}
            </div>
          )}
        </div>
      </div>

      {(isFailed || isPending) && (
        <Button 
          variant="outline" 
          size="sm" 
          className="rounded-full gap-2 border-white/10 shrink-0"
          onClick={handleRetry}
          disabled={retry.isPending}
        >
          {retry.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Retry
        </Button>
      )}
    </div>
  );
}
