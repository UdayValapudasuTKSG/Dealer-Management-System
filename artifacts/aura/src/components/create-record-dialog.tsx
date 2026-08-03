import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Loader2, Sparkles } from "lucide-react";

export type FieldDef = {
  name: string;
  label: string;
  type:
    | "text"
    | "number"
    | "select"
    | "date"
    | "textarea"
    | "custom"
    | "email"
    | "phone";
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
  span?: "full" | "half";
  render?: (value: string, set: (value: string) => void) => ReactNode;
  /** Optional observer so pages can react to a field change (e.g. show a
   * dependent field or prefill sibling fields via setField). */
  onChange?: (value: string, setField: (name: string, value: string) => void) => void;
  /** Optional custom validator; return an error message or null. Runs after
   * the built-in type checks. */
  validate?: (value: string) => string | null;
  /** For number fields: lower/upper bounds. */
  min?: number;
  max?: number;
  /** Optional section heading — fields sharing the same section render under
   * one labelled group with a divider. */
  section?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9()\-\s]{7,20}$/;

/** Built-in per-type validation. Empty values are only an error when the
 * field is required (blank optional fields are always fine). */
export function fieldError(f: FieldDef, raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return f.required ? `${f.label} is required` : null;
  switch (f.type) {
    case "email":
      if (!EMAIL_RE.test(value)) return "Enter a valid email address";
      break;
    case "phone":
      if (!PHONE_RE.test(value)) return "Enter a valid phone number";
      break;
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return "Enter a valid number";
      if (f.min !== undefined && n < f.min) return `Must be at least ${f.min}`;
      if (f.max !== undefined && n > f.max) return `Must be at most ${f.max}`;
      break;
    }
    case "date":
      if (Number.isNaN(new Date(value).getTime()))
        return "Enter a valid date";
      break;
  }
  return f.validate?.(value) ?? null;
}

type CreateRecordDialogProps = {
  trigger: ReactNode;
  title: string;
  description?: string;
  fields: FieldDef[];
  submitLabel?: string;
  pending?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void> | void;
};

export function CreateRecordDialog({
  trigger,
  title,
  description,
  fields,
  submitLabel = "Create",
  pending,
  open: openProp,
  onOpenChange,
  onSubmit,
}: CreateRecordDialogProps) {
  const [openState, setOpenState] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const setOpen = (next: boolean) => {
    if (!isControlled) setOpenState(next);
    onOpenChange?.(next);
  };
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""])),
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) {
      setValues(
        Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""])),
      );
      setTouched({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setField = (name: string, value: string) =>
    setValues((v) => ({ ...v, [name]: value }));

  const set = (name: string, value: string) => {
    setField(name, value);
    fields.find((f) => f.name === name)?.onChange?.(value, setField);
  };

  const errors = Object.fromEntries(
    fields.map((f) => [f.name, fieldError(f, values[f.name])]),
  ) as Record<string, string | null>;
  const hasErrors = fields.some((f) => errors[f.name] !== null);

  const handleSubmit = async () => {
    if (hasErrors) {
      // Reveal every problem at once instead of failing silently.
      setTouched(Object.fromEntries(fields.map((f) => [f.name, true])));
      return;
    }
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (raw === undefined || raw === "") continue;
      payload[f.name] = f.type === "number" ? Number(raw) : raw.trim();
    }
    await onSubmit(payload);
    setOpen(false);
    setValues(Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""])));
    setTouched({});
  };

  const missingRequired = fields.some(
    (f) => f.required && !values[f.name],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="glass-panel border-white/10 sm:max-w-[600px] p-5 gap-3"
        onPointerDownOutside={(e) => {
          // Radix Select/Popover content is portalled outside the dialog; a
          // fast double-click on a select option lands "outside" the dialog
          // and would close it. Ignore outside-pointerdowns that originate
          // from any portalled popper layer, AND any click made while a
          // dropdown is open — that click should only dismiss the dropdown,
          // never the whole dialog (a long form would lose all its input).
          const target = e.target as HTMLElement | null;
          if (
            target?.closest(
              "[data-radix-popper-content-wrapper], [data-radix-select-viewport], [role='listbox'], [role='option']",
            ) ||
            document.querySelector(
              "[data-radix-popper-content-wrapper], [data-radix-select-viewport]",
            )
          ) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          const target = e.target as HTMLElement | null;
          if (
            target?.closest(
              "[data-radix-popper-content-wrapper], [data-radix-select-viewport], [role='listbox'], [role='option']",
            ) ||
            document.querySelector(
              "[data-radix-popper-content-wrapper], [data-radix-select-viewport]",
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader className="space-y-0.5">
          <DialogTitle className="text-base tracking-tight">{title}</DialogTitle>
          {description && (
            <DialogDescription className="text-xs text-muted-foreground">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex flex-wrap gap-x-3 gap-y-2.5 py-1">
          {fields.map((f, i) => (
            <Fragment key={f.name}>
            {f.section && f.section !== fields[i - 1]?.section && (
              <div
                className={`w-full flex items-center gap-3 ${i > 0 ? "mt-1" : ""}`}
              >
                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary/80">
                  {f.section}
                </span>
                <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
              </div>
            )}
            <div
              className={`flex flex-col gap-1 ${
                f.span === "half"
                  ? "flex-1 basis-[30%] min-w-[140px]"
                  : "w-full"
              }`}
            >
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {f.label}
                {f.required && <span className="text-primary"> *</span>}
              </Label>
              {f.type === "custom" ? (
                f.render?.(values[f.name], (v) => set(f.name, v))
              ) : f.type === "select" ? (
                <Select value={values[f.name]} onValueChange={(v) => set(f.name, v)}>
                  <SelectTrigger className="h-8 text-xs bg-white/[0.04] border-white/10">
                    <SelectValue placeholder={f.placeholder ?? "Select"} />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : f.type === "textarea" ? (
                <Textarea
                  value={values[f.name]}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.name, e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, [f.name]: true }))}
                  className={`bg-white/[0.04] min-h-[56px] text-xs ${
                    touched[f.name] && errors[f.name]
                      ? "border-red-500/60 focus-visible:ring-red-500/30"
                      : "border-white/10"
                  }`}
                />
              ) : (
                <Input
                  type={
                    f.type === "number"
                      ? "number"
                      : f.type === "date"
                        ? "date"
                        : f.type === "email"
                          ? "email"
                          : f.type === "phone"
                            ? "tel"
                            : "text"
                  }
                  inputMode={
                    f.type === "number"
                      ? "decimal"
                      : f.type === "phone"
                        ? "tel"
                        : undefined
                  }
                  value={values[f.name]}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.name, e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, [f.name]: true }))}
                  className={`h-8 text-xs bg-white/[0.04] ${
                    touched[f.name] && errors[f.name]
                      ? "border-red-500/60 focus-visible:ring-red-500/30"
                      : "border-white/10"
                  }`}
                />
              )}
              {touched[f.name] && errors[f.name] && (
                <p className="text-[11px] text-red-400">{errors[f.name]}</p>
              )}
            </div>
            </Fragment>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/15 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <Sparkles className="w-3 h-3 text-primary shrink-0" />
          AURA will enrich, score, and route this record automatically once created.
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={missingRequired || pending}
            className="bg-primary hover:bg-primary/90 text-white rounded-full px-5 gap-2"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
