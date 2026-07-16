import { cn } from "@/lib/utils";

/**
 * Shared page container. Gives every standard page the same outer gutter as
 * the top navigation (px-5 md:px-8) at full width, plus uniform vertical
 * rhythm. Use `fill` for full-height layouts (e.g. kanban boards).
 */
export function Page({
  children,
  className,
  fill = false,
}: {
  children: React.ReactNode;
  className?: string;
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        "w-full px-5 md:px-8",
        fill
          ? "h-full flex flex-col py-8 md:py-10"
          : "py-10 md:py-14",
        !fill && "animate-in fade-in slide-in-from-bottom-4 duration-500",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Consistent page header: an eyebrow-less title/subtitle pair with an optional
 * trailing action slot. Keeps typographic rhythm uniform across pages.
 */
export function PageHeader({
  title,
  accent,
  subtitle,
  action,
  className,
}: {
  title: string;
  accent?: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-5 md:flex-row md:items-end md:justify-between",
        className,
      )}
    >
      <div>
        <h1 className="text-4xl md:text-5xl font-light tracking-tight leading-[1.05]">
          {title}
          {accent && <span className="font-semibold"> {accent}</span>}
        </h1>
        {subtitle && (
          <p className="text-muted-foreground text-lg mt-3 font-light">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
