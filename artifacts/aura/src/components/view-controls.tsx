import { LayoutGrid, List, Rows2, Rows3 } from "lucide-react";
import type { Density, Layout } from "@/hooks/use-view-mode";

interface ViewControlsProps {
  layout: Layout;
  onLayoutChange: (l: Layout) => void;
  density: Density;
  onDensityChange: (d: Density) => void;
}

function Segment({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`h-8 px-2.5 rounded-lg flex items-center justify-center transition-colors ${
        active
          ? "bg-primary text-white"
          : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
      }`}
    >
      {children}
    </button>
  );
}

export function ViewControls({ layout, onLayoutChange, density, onDensityChange }: ViewControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-0.5 p-0.5 rounded-xl border border-white/10 bg-white/[0.04]">
        <Segment active={layout === "grid"} onClick={() => onLayoutChange("grid")} label="Grid view">
          <LayoutGrid className="w-4 h-4" />
        </Segment>
        <Segment active={layout === "list"} onClick={() => onLayoutChange("list")} label="List view">
          <List className="w-4 h-4" />
        </Segment>
      </div>
      <div className="flex items-center gap-0.5 p-0.5 rounded-xl border border-white/10 bg-white/[0.04]">
        <Segment
          active={density === "compact"}
          onClick={() => onDensityChange("compact")}
          label="Compact density"
        >
          <Rows3 className="w-4 h-4" />
        </Segment>
        <Segment
          active={density === "comfortable"}
          onClick={() => onDensityChange("comfortable")}
          label="Comfortable density"
        >
          <Rows2 className="w-4 h-4" />
        </Segment>
      </div>
    </div>
  );
}
