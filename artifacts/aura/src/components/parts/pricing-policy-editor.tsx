import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";

export interface PartPricingPolicy {
  id: number;
  category: string | null;
  markupFactor: number;
  updatedAt: string;
}

const policiesKey = ["parts", "pricing-policies"] as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The pricing policy request failed.";
}

export function PricingPolicyEditor({ onPolicyChanged }: { onPolicyChanged?: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [category, setCategory] = useState("");
  const [factor, setFactor] = useState("1.25");

  const policies = useQuery({
    queryKey: policiesKey,
    queryFn: () => customFetch<PartPricingPolicy[]>("/api/parts/pricing-policies"),
  });

  const save = useMutation({
    mutationFn: (input: { category: string | null; markupFactor: number }) =>
      customFetch<PartPricingPolicy>("/api/parts/pricing-policies", {
        method: "PUT",
        body: JSON.stringify(input),
        responseType: "json",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: policiesKey });
      onPolicyChanged?.();
      toast({ title: "Pricing policy saved" });
    },
    onError: (error) =>
      toast({ title: "Could not save policy", description: errorMessage(error), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: (id: number) =>
      customFetch<null>(`/api/parts/pricing-policies/${id}`, {
        method: "DELETE",
        responseType: "json",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: policiesKey });
      onPolicyChanged?.();
      toast({ title: "Pricing policy removed" });
    },
    onError: (error) =>
      toast({ title: "Could not remove policy", description: errorMessage(error), variant: "destructive" }),
  });

  const submit = () => {
    const markupFactor = Number(factor);
    if (!Number.isFinite(markupFactor) || markupFactor < 0 || markupFactor > 1000) {
      toast({
        title: "Enter a valid markup factor",
        description: "Use a number from 0 to 1000. For example, 1.25 means cost × 1.25.",
        variant: "destructive",
      });
      return;
    }
    save.mutate({ category: category.trim() || null, markupFactor });
  };

  return (
    <section className="space-y-3 rounded-xl border border-border/70 bg-foreground/[0.025] p-4">
      <div>
        <h3 className="text-sm font-semibold">Automatic pricing policies</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Used only when an imported row has no sell price. Category rules override the global fallback.
        </p>
      </div>

      {policies.isLoading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground" data-testid="status-pricing-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading policies…
        </div>
      ) : policies.isError ? (
        <p className="text-xs text-destructive" data-testid="status-pricing-error">
          {errorMessage(policies.error)}
        </p>
      ) : (
        <div className="space-y-2" data-testid="list-pricing-policies">
          {(policies.data ?? []).length === 0 && (
            <p className="text-xs text-amber-500">No fallback is configured. Rows without a sell price will not validate.</p>
          )}
          {(policies.data ?? []).map((policy) => (
            <div key={policy.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">
                {policy.category ?? "Global fallback"}
              </span>
              <span className="text-muted-foreground" data-testid={`text-pricing-factor-${policy.id}`}>
                cost × {policy.markupFactor}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(policy.id)}
                aria-label={`Delete ${policy.category ?? "global"} pricing policy`}
                data-testid={`button-delete-pricing-policy-${policy.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="pricing-category" className="text-xs">Category</Label>
          <Input
            id="pricing-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Blank = global"
            data-testid="input-pricing-category"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pricing-factor" className="text-xs">Markup factor</Label>
          <Input
            id="pricing-factor"
            type="number"
            min="0"
            max="1000"
            step="0.01"
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
            data-testid="input-pricing-factor"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={submit}
          disabled={save.isPending}
          data-testid="button-save-pricing-policy"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : category.trim() ? <Plus className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          Save
        </Button>
      </div>
    </section>
  );
}