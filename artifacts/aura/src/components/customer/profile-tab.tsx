import { useState } from "react";
import {
  useUpdateCustomer,
  getGetCustomerOverviewQueryKey,
  getListCustomersQueryKey,
  type Customer,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CreateRecordDialog, type FieldDef } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { Pencil, Plus, X, Tag } from "lucide-react";

const PROFILE_FIELDS: {
  key: keyof Customer;
  label: string;
}[] = [
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "dateOfBirth", label: "Date of Birth" },
  { key: "occupation", label: "Occupation" },
  { key: "company", label: "Company" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
  { key: "location", label: "Location" },
  { key: "taxNumber", label: "Tax Number (TIN)" },
];

export function ProfileTab({ customer }: { customer: Customer }) {
  const [editOpen, setEditOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateCustomer();

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetCustomerOverviewQueryKey(customer.id),
    });
    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
  };

  const tags = customer.tags ?? [];

  const saveTags = async (next: string[]) => {
    try {
      await update.mutateAsync({ id: customer.id, data: { tags: next } });
      invalidate();
    } catch {
      toast({ title: "Could not update tags", variant: "destructive" });
    }
  };

  const addTag = async () => {
    const t = newTag.trim().toLowerCase();
    if (!t || tags.includes(t)) {
      setNewTag("");
      return;
    }
    setNewTag("");
    await saveTags([...tags, t]);
  };

  const editFields: FieldDef[] = [
    { name: "name", label: "Full name", type: "text", required: true, span: "full", defaultValue: customer.name },
    { name: "email", label: "Email", type: "text", span: "half", defaultValue: customer.email ?? "" },
    { name: "phone", label: "Phone", type: "text", span: "half", defaultValue: customer.phone ?? "" },
    { name: "whatsapp", label: "WhatsApp", type: "text", span: "half", defaultValue: customer.whatsapp ?? "" },
    { name: "dateOfBirth", label: "Date of birth", type: "date", span: "half", defaultValue: customer.dateOfBirth ?? "" },
    { name: "occupation", label: "Occupation", type: "text", span: "half", defaultValue: customer.occupation ?? "" },
    { name: "company", label: "Company", type: "text", span: "half", defaultValue: customer.company ?? "" },
    { name: "address", label: "Address", type: "text", span: "full", defaultValue: customer.address ?? "" },
    { name: "city", label: "City", type: "text", span: "half", defaultValue: customer.city ?? "" },
    { name: "country", label: "Country", type: "text", span: "half", defaultValue: customer.country ?? "" },
    { name: "location", label: "Location", type: "text", span: "half", defaultValue: customer.location ?? "" },
    { name: "taxNumber", label: "Tax number (TIN)", type: "text", span: "half", defaultValue: customer.taxNumber ?? "" },
    {
      name: "loyaltyTier",
      label: "Loyalty tier",
      type: "select",
      span: "half",
      defaultValue: customer.loyaltyTier,
      options: [
        { value: "new", label: "New" },
        { value: "silver", label: "Silver" },
        { value: "gold", label: "Gold" },
        { value: "platinum", label: "Platinum" },
      ],
    },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <Card className="glass-panel border-none shadow-lg lg:col-span-2">
        <CardContent className="p-6 md:p-8">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Profile Details
            </h3>
            <CreateRecordDialog
              title="Edit Profile"
              description="Update this client's contact and identity details."
              open={editOpen}
              onOpenChange={setEditOpen}
              pending={update.isPending}
              submitLabel="Save Changes"
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full border-white/10 bg-white/[0.04] gap-2"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
              }
              fields={editFields}
              onSubmit={async (values) => {
                try {
                  await update.mutateAsync({
                    id: customer.id,
                    data: values as never,
                  });
                  invalidate();
                  toast({ title: "Profile updated" });
                } catch {
                  toast({
                    title: "Could not update profile",
                    variant: "destructive",
                  });
                  throw new Error("update failed");
                }
              }}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
            {PROFILE_FIELDS.map(({ key, label }) => {
              const value = customer[key];
              return (
                <div key={key} className="min-w-0">
                  <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                    {label}
                  </div>
                  <div className="text-sm font-medium truncate">
                    {value != null && value !== "" ? (
                      String(value)
                    ) : (
                      <span className="text-muted-foreground/40 font-light">
                        Not provided
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="glass-panel border-none shadow-lg h-fit">
        <CardContent className="p-6 space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground flex items-center gap-2">
            <Tag className="w-4 h-4" /> Tags
          </h3>
          <div className="flex flex-wrap gap-2">
            {tags.length === 0 && (
              <p className="text-sm text-muted-foreground font-light">
                No tags yet.
              </p>
            )}
            {tags.map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="rounded-full bg-white/[0.06] border border-white/10 text-foreground gap-1.5 pr-1.5"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => void saveTags(tags.filter((t) => t !== tag))}
                  className="rounded-full p-0.5 hover:bg-primary/20 hover:text-primary transition-colors"
                  aria-label={`Remove ${tag}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addTag();
                }
              }}
              placeholder="vip, cash-buyer…"
              className="bg-white/[0.04] border-white/10 h-9"
            />
            <Button
              size="icon"
              onClick={() => void addTag()}
              disabled={update.isPending || !newTag.trim()}
              className="h-9 w-9 rounded-full bg-primary hover:bg-primary/90 text-white shrink-0"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
