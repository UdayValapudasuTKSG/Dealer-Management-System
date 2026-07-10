import { cn } from "@/lib/utils";

type PageWidth = "narrow" | "default" | "wide" | "full";

const WIDTH_CLASS: Record<PageWidth, string> = {
  narrow: "max-w-5xl",
  default: "max-w-7xl",
  wide: "max-w-[1600px]",
  full: "max-w-none",
};

/**
 * Shared page container. Gives every standard page consistent outer padding,
 * a sensible max content width, and uniform vertical rhythm so nothing hugs
 * the window edges. Use `fill` for full-height layouts (e.g. kanban boards).
 */
export function Page({
  children,
  className,
  width = "default",
  fill = false,
}: {
  children: React.ReactNode;
  className?: string;
  width?: PageWidth;
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-6 md:px-10 lg:px-14",
        WIDTH_CLASS[width],
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
