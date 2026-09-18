import { Calendar, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ServiceBookingFilters } from "@/lib/service-booking-filters";

const statuses = [
  "open",
  "acknowledged",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "cancelled",
];
const serviceTypes = [
  "maintenance",
  "repair",
  "warranty",
  "recall",
  "inspection",
  "comeback",
  "unscheduled",
];

type BookingFilterControlsProps = {
  filters: ServiceBookingFilters;
  from: string;
  to: string;
  resultCount: number;
  totalCount: number;
  onFiltersChange: (filters: ServiceBookingFilters) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onClearAll: () => void;
};

const label = (value: string) => value.replace(/_/g, " ");

export function BookingFilterControls({
  filters,
  from,
  to,
  resultCount,
  totalCount,
  onFiltersChange,
  onFromChange,
  onToChange,
  onClearAll,
}: BookingFilterControlsProps) {
  const hasCriteria =
    Boolean(from || to || filters.search.trim()) ||
    filters.status !== "all" ||
    filters.serviceType !== "all";

  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3">
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_11rem_11rem_auto]">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search service bookings"
            placeholder="Search RO, customer, vehicle, concern…"
            value={filters.search}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            className="h-10 bg-white/[0.04] pl-9"
          />
        </div>
        <Select
          value={filters.status}
          onValueChange={(status) => onFiltersChange({ ...filters, status })}
        >
          <SelectTrigger className="h-10 bg-white/[0.04]" aria-label="Filter by booking status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statuses.map((status) => (
              <SelectItem key={status} value={status} className="capitalize">
                {label(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.serviceType}
          onValueChange={(serviceType) => onFiltersChange({ ...filters, serviceType })}
        >
          <SelectTrigger className="h-10 bg-white/[0.04]" aria-label="Filter by service type">
            <SelectValue placeholder="All service types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All service types</SelectItem>
            {serviceTypes.map((serviceType) => (
              <SelectItem key={serviceType} value={serviceType} className="capitalize">
                {label(serviceType)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          className="h-10 justify-center"
          onClick={onClearAll}
          disabled={!hasCriteria}
          aria-label="Clear all booking filters"
        >
          <X className="mr-1.5 h-4 w-4" />
          Clear all
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            type="date"
            aria-label="Scheduled from date"
            value={from}
            onChange={(event) => onFromChange(event.target.value)}
            className="h-9 w-[9.5rem] bg-white/[0.04] text-xs"
            data-testid="input-filter-from"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="Scheduled to date"
            value={to}
            onChange={(event) => onToChange(event.target.value)}
            className="h-9 w-[9.5rem] bg-white/[0.04] text-xs"
            data-testid="input-filter-to"
          />
          {(from || to) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onFromChange("");
                onToChange("");
              }}
              aria-label="Clear scheduled date range"
              data-testid="button-clear-date-filter"
            >
              Clear dates
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {resultCount === totalCount
            ? `${resultCount} ${resultCount === 1 ? "booking" : "bookings"}`
            : `${resultCount} of ${totalCount} bookings`}
        </p>
      </div>
    </div>
  );
}