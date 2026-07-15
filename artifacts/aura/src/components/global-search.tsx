import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useGlobalSearch } from "@workspace/api-client-react";
import {
  Search,
  Users,
  Car,
  Target,
  Receipt,
  CalendarClock,
  Wrench,
  Loader2,
} from "lucide-react";

const GROUP_ICON: Record<string, typeof Users> = {
  customers: Users,
  vehicles: Car,
  leads: Target,
  invoices: Receipt,
  bookings: CalendarClock,
  service: Wrench,
};

export function GlobalSearchButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Search everything"
        className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-foreground/[0.04] hover:bg-foreground/[0.08] px-3 md:pr-2.5 transition-colors text-muted-foreground hover:text-foreground"
      >
        <Search className="h-4 w-4" />
        <span className="hidden lg:inline text-sm">Search</span>
        <kbd className="hidden lg:inline-flex items-center gap-0.5 rounded-md border border-white/10 bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide">
          ⌘K
        </kbd>
      </button>
      <GlobalSearchDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);

  const { data, isFetching } = useGlobalSearch({ q: debounced });
  const groups = debounced.length >= 2 ? (data?.groups ?? []) : [];

  const go = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl top-[20%] translate-y-0">
        <DialogTitle className="sr-only">Search everything</DialogTitle>
        <CommandPrimitive
          shouldFilter={false}
          className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
        >
          <CommandInput
            placeholder="Search customers, vehicles, leads, invoices, bookings, service…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[420px]">
            {debounced.length < 2 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Type at least two characters to search across the dealership.
              </div>
            ) : isFetching && groups.length === 0 ? (
              <div className="py-10 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : (
              <CommandEmpty>No results for “{debounced}”.</CommandEmpty>
            )}
            {groups.map((group) => {
              const Icon = GROUP_ICON[group.key] ?? Search;
              return (
                <CommandGroup key={group.key} heading={group.label}>
                  {group.items.map((item) => (
                    <CommandItem
                      key={`${group.key}-${item.id}`}
                      value={`${group.key}-${item.id}`}
                      onSelect={() => go(item.href)}
                      className="flex items-center gap-3 cursor-pointer"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {item.title}
                        </span>
                        {item.subtitle && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                      {item.meta && (
                        <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {item.meta.replace(/_/g, " ")}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}
