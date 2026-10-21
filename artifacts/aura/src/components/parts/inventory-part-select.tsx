import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getListPartsQueryKey, listParts } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandItem } from "@/components/ui/command";
import { ChevronsUpDown, Check } from "lucide-react";
import { indexInventory, searchInventory } from "./inventory-search";

export function InventoryPartSelect({ value, onChange, activeOnly = false, ariaLabel = "Inventory part" }: {
  value: string;
  onChange: (value: string) => void;
  activeOnly?: boolean;
  ariaLabel?: string;
}) {
  const { activeDealer } = useAuthz();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...getListPartsQueryKey(), "request-picker", activeDealer?.dealerId],
    queryFn: ({ signal }) => listParts(undefined, { signal }),
    enabled: !!activeDealer && (open || !!value),
    staleTime: 30_000,
  });
  const index = useMemo(() => indexInventory((data ?? []).filter(part => !activeOnly || part.status === "active")), [data, activeOnly]);
  const result = useMemo(() => searchInventory(index, search), [index, search]);
  const selected = data?.find(part => String(part.id) === value);
  return (
    <Popover modal open={open} onOpenChange={next => { setOpen(next); if (next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-label={ariaLabel} aria-expanded={open} className="w-full min-w-0 justify-between font-normal">
          <span className="truncate">{selected ? `${selected.sku} — ${selected.name} (${selected.stock} in stock)` : "Search inventory..."}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[--radix-popover-trigger-width]">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Part number, name or barcode..." aria-label={`Search ${ariaLabel}`} />
          <CommandList className="max-h-60">
            {isLoading ? <p className="p-3 text-sm" role="status">Loading inventory…</p> : isError ? (
              <div className="p-3 text-sm" role="alert">Could not load inventory. <Button type="button" variant="link" onClick={() => refetch()}>Retry</Button></div>
            ) : <>
              {result.parts.map(part => (
                <CommandItem key={part.id} value={String(part.id)} onSelect={() => { onChange(String(part.id)); setOpen(false); }}>
                  <Check className={`mr-2 h-4 w-4 shrink-0 ${value === String(part.id) ? "opacity-100" : "opacity-0"}`} />
                  <span>{part.sku} — {part.name} ({part.stock} in stock)</span>
                </CommandItem>
              ))}
              {!result.parts.length && <p className="p-3 text-sm text-muted-foreground" role="status">No matching parts. Try another part number, name or barcode.</p>}
              {result.hasMore && <p className="p-3 text-xs text-muted-foreground" role="status">Showing first 50 matches. Type more to narrow your search.</p>}
            </>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
