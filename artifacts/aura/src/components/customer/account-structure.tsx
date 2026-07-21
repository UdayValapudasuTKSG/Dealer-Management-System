import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateContact,
  useUpdateContact,
  useDeleteContact,
  useUpdateCustomer,
  useListCustomers,
  getGetCustomerOverviewQueryKey,
  type Contact,
  type Asset,
  type AccountRelations,
  type Customer,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { formatGuyanaDate } from "@/lib/format";
import {
  Users,
  Car,
  Plus,
  Star,
  Trash2,
  Pencil,
  Building2,
  User,
  Wrench,
  Link2,
  Unlink,
} from "lucide-react";

const withBase = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;

// ---------------------------------------------------------------------------
// Contacts — people under a Business account
// ---------------------------------------------------------------------------

function ContactDialog({
  customerId,
  contact,
  trigger,
}: {
  customerId: number;
  contact?: Contact;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(contact?.name ?? "");
  const [title, setTitle] = useState(contact?.title ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createContact = useCreateContact();
  const updateContact = useUpdateContact();

  const pending = createContact.isPending || updateContact.isPending;

  const submit = async () => {
    if (!name.trim()) return;
    const data = {
      name: name.trim(),
      title: title.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      isPrimary,
    };
    try {
      if (contact) {
        await updateContact.mutateAsync({
          id: customerId,
          contactId: contact.id,
          data,
        });
      } else {
        await createContact.mutateAsync({ id: customerId, data });
      }
      queryClient.invalidateQueries({
        queryKey: getGetCustomerOverviewQueryKey(customerId),
      });
      toast({ title: contact ? "Contact updated" : "Contact added" });
      setOpen(false);
      if (!contact) {
        setName("");
        setTitle("");
        setEmail("");
        setPhone("");
        setIsPrimary(false);
      }
    } catch {
      toast({ title: "Could not save contact", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
          <DialogDescription>
            People who act on behalf of this account.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ama Boateng"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Fleet Manager"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+592 …"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ama@company.com"
            />
          </div>
          <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-4 py-3">
            <div>
              <div className="text-sm font-medium">Primary contact</div>
              <div className="text-xs text-muted-foreground">
                Main point of contact for this account
              </div>
            </div>
            <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
          </div>
          <Button
            className="w-full"
            disabled={pending || !name.trim()}
            onClick={submit}
          >
            {contact ? "Save changes" : "Add contact"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ContactsSection({
  customerId,
  contacts,
}: {
  customerId: number;
  contacts: Contact[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteContact = useDeleteContact();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-wide flex items-center gap-2">
          <Users className="w-4 h-4 text-muted-foreground" /> Contacts
        </h2>
        <ContactDialog
          customerId={customerId}
          trigger={
            <Button size="sm" variant="outline" className="rounded-full gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add
            </Button>
          }
        />
      </div>
      <Card className="glass-panel border-none shadow-lg">
        <CardContent className="p-4 space-y-2">
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No contacts yet. Add the people who act for this account.
            </p>
          ) : (
            contacts.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 p-3 rounded-2xl bg-white/[0.03] group"
              >
                <div className="w-9 h-9 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0">
                  <User className="w-4 h-4 text-muted-foreground/50" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold truncate">
                      {c.name}
                    </span>
                    {c.isPrimary && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-500">
                        <Star className="w-3 h-3 fill-current" /> Primary
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {[c.title, c.email, c.phone].filter(Boolean).join(" · ") ||
                      "No details"}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <ContactDialog
                    customerId={customerId}
                    contact={c}
                    trigger={
                      <Button size="icon" variant="ghost" className="h-8 w-8">
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive"
                    disabled={deleteContact.isPending}
                    onClick={async () => {
                      try {
                        await deleteContact.mutateAsync({
                          id: customerId,
                          contactId: c.id,
                        });
                        queryClient.invalidateQueries({
                          queryKey: getGetCustomerOverviewQueryKey(customerId),
                        });
                        toast({ title: "Contact removed" });
                      } catch {
                        toast({
                          title: "Could not remove contact",
                          variant: "destructive",
                        });
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assets — lifetime garage
// ---------------------------------------------------------------------------

export function AssetsSection({ assets }: { assets: Asset[] }) {
  if (assets.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold tracking-wide flex items-center gap-2">
        <Car className="w-4 h-4 text-muted-foreground" /> Garage
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {assets.map((a) => (
          <Card
            key={a.id}
            className="glass-panel border-none shadow-lg overflow-hidden"
          >
            <CardContent className="p-0">
              <div className="h-32 bg-white/[0.04] flex items-center justify-center overflow-hidden">
                {a.vehicleImageUrl ? (
                  <img
                    src={withBase(a.vehicleImageUrl)}
                    alt={a.vehicleLabel ?? "Vehicle"}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Car className="w-10 h-10 text-muted-foreground/30" />
                )}
              </div>
              <div className="p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">
                    {a.vehicleLabel ?? `Vehicle #${a.vehicleId}`}
                  </span>
                  <Badge
                    className={
                      a.status === "active"
                        ? "rounded-full text-[10px] uppercase tracking-widest bg-emerald-500/15 text-emerald-500 border-none"
                        : "rounded-full text-[10px] uppercase tracking-widest bg-white/[0.06] text-muted-foreground border-none"
                    }
                  >
                    {a.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  {a.registration && <div>Reg: {a.registration}</div>}
                  {a.vin && <div className="truncate">VIN: {a.vin}</div>}
                  <div>Delivered {formatGuyanaDate(a.deliveredAt)}</div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border/40 text-xs">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Wrench className="w-3.5 h-3.5" />
                    {a.serviceOrderCount} service order
                    {a.serviceOrderCount === 1 ? "" : "s"}
                    {a.lastServiceAt
                      ? ` · last ${formatGuyanaDate(a.lastServiceAt)}`
                      : ""}
                  </span>
                </div>
                {a.serviceAdvisorName && (
                  <div className="text-xs text-muted-foreground">
                    Service Advisor:{" "}
                    <span className="text-foreground font-medium">
                      {a.serviceAdvisorName}
                    </span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relations — household / parent business grouping
// ---------------------------------------------------------------------------

export function RelationsSection({
  customer,
  relations,
}: {
  customer: Customer;
  relations: AccountRelations;
}) {
  const [open, setOpen] = useState(false);
  const [parentId, setParentId] = useState<string>("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateCustomer = useUpdateCustomer();
  const { data: allCustomers } = useListCustomers({
    query: { enabled: open },
  } as never);

  const candidates = (allCustomers ?? []).filter(
    (c) => c.id !== customer.id && c.parentAccountId !== customer.id,
  );

  const setParent = async (value: number | null) => {
    try {
      await updateCustomer.mutateAsync({
        id: customer.id,
        data: { parentAccountId: value } as never,
      });
      queryClient.invalidateQueries({
        queryKey: getGetCustomerOverviewQueryKey(customer.id),
      });
      toast({
        title: value ? "Account linked" : "Account unlinked",
      });
      setOpen(false);
      setParentId("");
    } catch (err) {
      toast({
        title: "Could not update grouping",
        description:
          err instanceof Error ? err.message : "The link was rejected.",
        variant: "destructive",
      });
    }
  };

  const hasAny = relations.parent || relations.children.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-wide flex items-center gap-2">
          <Link2 className="w-4 h-4 text-muted-foreground" /> Household &
          Group
        </h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="rounded-full gap-1.5">
              <Link2 className="w-3.5 h-3.5" />
              {relations.parent ? "Change" : "Link"}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Group under an account</DialogTitle>
              <DialogDescription>
                Link {customer.name} under a household head or parent
                business.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose parent account…" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                      {c.accountType === "business" ? " (Business)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="w-full"
                disabled={!parentId || updateCustomer.isPending}
                onClick={() => setParent(Number(parentId))}
              >
                Link account
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <Card className="glass-panel border-none shadow-lg">
        <CardContent className="p-4 space-y-2">
          {!hasAny ? (
            <p className="text-sm text-muted-foreground py-2">
              Not grouped with any other account.
            </p>
          ) : (
            <>
              {relations.parent && (
                <div className="flex items-center gap-3 p-3 rounded-2xl bg-white/[0.03] group">
                  <div className="w-9 h-9 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0">
                    {relations.parent.accountType === "business" ? (
                      <Building2 className="w-4 h-4 text-gold" />
                    ) : (
                      <User className="w-4 h-4 text-muted-foreground/50" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/customers/${relations.parent.id}`}
                      className="text-sm font-semibold hover:text-primary transition-colors"
                    >
                      {relations.parent.name}
                    </Link>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      Parent account
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Unlink"
                    disabled={updateCustomer.isPending}
                    onClick={() => setParent(null)}
                  >
                    <Unlink className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
              {relations.children.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 p-3 rounded-2xl bg-white/[0.03]"
                >
                  <div className="w-9 h-9 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0">
                    {c.accountType === "business" ? (
                      <Building2 className="w-4 h-4 text-gold" />
                    ) : (
                      <User className="w-4 h-4 text-muted-foreground/50" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/customers/${c.id}`}
                      className="text-sm font-semibold hover:text-primary transition-colors"
                    >
                      {c.name}
                    </Link>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      Member
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
