import { useEffect, useState, type ReactNode } from "react";
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
  type: "text" | "number" | "select" | "date" | "textarea" | "custom";
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
  span?: "full" | "half";
  render?: (value: string, set: (value: string) => void) => ReactNode;
  /** Optional observer so pages can react to a field change (e.g. show a dependent field). */
  onChange?: (value: string) => void;
};

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

  useEffect(() => {
    if (open) {
      setValues(
        Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""])),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    fields.find((f) => f.name === name)?.onChange?.(value);
  };

  const handleSubmit = async () => {
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (raw === undefined || raw === "") continue;
      payload[f.name] = f.type === "number" ? Number(raw) : raw;
    }
    await onSubmit(payload);
    setOpen(false);
    setValues(Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""])));
  };

  const missingRequired = fields.some(
    (f) => f.required && !values[f.name],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-xl tracking-tight">{title}</DialogTitle>
          {description && (
            <DialogDescription className="text-muted-foreground">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          {fields.map((f) => (
            <div
              key={f.name}
              className={`flex flex-col gap-1.5 ${f.span === "half" ? "col-span-1" : "col-span-2"}`}
            >
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                {f.label}
                {f.required && <span className="text-primary"> *</span>}
              </Label>
              {f.type === "custom" ? (
                f.render?.(values[f.name], (v) => set(f.name, v))
              ) : f.type === "select" ? (
                <Select value={values[f.name]} onValueChange={(v) => set(f.name, v)}>
                  <SelectTrigger className="bg-white/[0.04] border-white/10">
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
                  className="bg-white/[0.04] border-white/10 min-h-[72px]"
                />
              ) : (
                <Input
                  type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                  value={values[f.name]}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.name, e.target.value)}
                  className="bg-white/[0.04] border-white/10"
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-primary/5 border border-primary/15 px-3 py-2 text-xs text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
          AURA will enrich, score, and route this record automatically once created.
        </div>
        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={missingRequired || pending}
            className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
