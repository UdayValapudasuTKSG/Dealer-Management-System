import React, { useState } from "react";
import {
  useListCollisionPortalInvitations,
  useCreateCollisionPortalInvitation,
  useRevokeCollisionPortalInvitation,
  type CollisionPortalInvitation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Copy, Plus, XCircle, ExternalLink, Link, Clock, Loader2 } from "lucide-react";
import { formatGuyanaDateTime } from "@/lib/format";

export function CollisionPortalLinksCard({ claimId }: { claimId: number }) {
  const { data: links, isLoading } = useListCollisionPortalInvitations(claimId);
  const revoke = useRevokeCollisionPortalInvitation();
  const qc = useQueryClient();
  const { toast } = useToast();
  
  const [createOpen, setCreateOpen] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const create = useCreateCollisionPortalInvitation();

  const handleCreate = async () => {
    try {
      const res = await create.mutateAsync({
        id: claimId,
        data: {
          expiresInDays: Number(expiresInDays),
          idempotencyKey: crypto.randomUUID(),
        }
      });
      setCreatedToken((res as any).token);
      toast({ title: "Invitation link created" });
      qc.invalidateQueries({ queryKey: ["listCollisionPortalInvitations"] } as any);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleRevoke = async (id: number) => {
    if (!confirm("Are you sure you want to revoke this link?")) return;
    try {
      await revoke.mutateAsync({ id: claimId, invitationId: id });
      toast({ title: "Link revoked" });
      qc.invalidateQueries({ queryKey: ["listCollisionPortalInvitations"] } as any);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const copyToClipboard = (token: string) => {
    const url = `${window.location.origin}/collision-portal/${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Link copied to clipboard" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
         <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Customer Portal Links</div>
         <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) setCreatedToken(null); }}>
           <DialogTrigger asChild>
             <Button size="sm" variant="outline" className="h-8 shadow-sm">
               <Plus className="w-3.5 h-3.5 mr-1" /> New Link
             </Button>
           </DialogTrigger>
           <DialogContent>
             <DialogHeader><DialogTitle>Create Portal Link</DialogTitle></DialogHeader>
             {createdToken ? (
               <div className="space-y-4 py-4">
                 <div className="p-3 bg-emerald-500/10 text-emerald-600 rounded-md border border-emerald-500/20 text-sm">
                   Link generated successfully. This is the only time it will be shown.
                 </div>
                 <div className="flex items-center gap-2">
                   <Input readOnly value={`${window.location.origin}/collision-portal/${createdToken}`} className="font-mono text-xs" />
                   <Button onClick={() => copyToClipboard(createdToken)}>Copy</Button>
                 </div>
               </div>
             ) : (
               <>
                 <div className="space-y-4 py-4">
                    <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
                      A secure link will be emailed directly to the linked customer’s stored email address.
                   </div>
                   <div className="space-y-2">
                     <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Expires In (Days)</label>
                     <Input type="number" min="1" max="30" value={expiresInDays} onChange={e => setExpiresInDays(e.target.value)} />
                   </div>
                 </div>
                 <DialogFooter>
                   <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button disabled={create.isPending} onClick={handleCreate}>
                     {create.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Email Secure Link
                   </Button>
                 </DialogFooter>
               </>
             )}
           </DialogContent>
         </Dialog>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground text-center py-4 border border-dashed border-border/40 rounded-lg">Loading links...</div>
      ) : links?.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-4 border border-dashed border-border/40 rounded-lg">
          No portal links active for this claim.
        </div>
      ) : (
        <div className="space-y-2">
          {links?.map((link: any) => {
            const isRevoked = !!link.revokedAt;
            const isExpired = new Date(link.expiresAt) < new Date();
            const isActive = !isRevoked && !isExpired;

            return (
              <div key={link.id} className={`p-3 rounded-lg border flex items-center justify-between gap-4 ${isActive ? 'border-border/60 bg-muted/10' : 'border-border/30 bg-muted/5 opacity-70'}`}>
                <div className="space-y-1">
                  <div className="font-medium text-sm flex items-center gap-2">
                    {link.email}
                    {isRevoked ? (
                      <span className="text-[10px] uppercase font-bold text-red-500 bg-red-500/10 px-1.5 py-0.5 rounded">Revoked</span>
                    ) : isExpired ? (
                      <span className="text-[10px] uppercase font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">Expired</span>
                    ) : (
                      <span className="text-[10px] uppercase font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">Active</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Exp: {formatGuyanaDateTime(link.expiresAt)}</span>
                  </div>
                </div>
                {isActive && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-red-500 hover:text-red-600" onClick={() => handleRevoke(link.id)}>
                      <XCircle className="w-3.5 h-3.5 mr-1" /> Revoke
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
