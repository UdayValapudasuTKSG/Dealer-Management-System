import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, Plus, GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function VehicleInterestsField({ 
  value, 
  onChange, 
  vehicles 
}: { 
  value: string; 
  onChange: (v: string) => void;
  vehicles: any[];
}) {
  const interests = useMemo(() => {
    try {
      return value ? JSON.parse(value) : [];
    } catch {
      return [];
    }
  }, [value]);

  const add = () => {
    onChange(JSON.stringify([...interests, { vehicleId: null, quantity: 1, position: interests.length }]));
  };

  const update = (index: number, updates: any) => {
    const next = [...interests];
    next[index] = { ...next[index], ...updates };
    onChange(JSON.stringify(next));
  };

  const remove = (index: number) => {
    const next = [...interests];
    next.splice(index, 1);
    next.forEach((item, i) => item.position = i);
    onChange(JSON.stringify(next));
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const next = [...interests];
    const temp = next[index - 1];
    next[index - 1] = next[index];
    next[index] = temp;
    next.forEach((item, i) => item.position = i);
    onChange(JSON.stringify(next));
  };
  
  const moveDown = (index: number) => {
    if (index === interests.length - 1) return;
    const next = [...interests];
    const temp = next[index + 1];
    next[index + 1] = next[index];
    next[index] = temp;
    next.forEach((item, i) => item.position = i);
    onChange(JSON.stringify(next));
  };

  if (interests.length === 0) {
    return (
      <Button type="button" variant="outline" onClick={add} className="w-full border-dashed border-white/20 bg-white/[0.02] text-muted-foreground h-12">
        <Plus className="w-4 h-4 mr-2" /> Add vehicle interest
      </Button>
    );
  }

  return (
    <div className="space-y-3 w-full">
      {interests.map((interest: any, i: number) => (
        <div key={i} className="flex flex-col gap-2 p-3 rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Vehicle {i + 1}
              </span>
              {i === 0 && (
                <Badge variant="secondary" className="px-1.5 py-0 text-[9px] h-4 bg-primary/20 text-primary border-none">
                  Primary
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6 rounded-full" onClick={() => moveUp(i)} disabled={i === 0}>
                <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6 rounded-full" onClick={() => moveDown(i)} disabled={i === interests.length - 1}>
                <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6 rounded-full text-red-400 hover:text-red-300 hover:bg-red-400/10" onClick={() => remove(i)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <select 
                value={interest.vehicleId || ""} 
                onChange={(e) => update(i, { vehicleId: parseInt(e.target.value) || null })}
                className="w-full h-9 rounded-md bg-foreground/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50"
              >
                <option value="">Select a vehicle...</option>
                {vehicles.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.year} {v.make} {v.model} {v.trim || v.variant || ""} ({v.exteriorColor}) - {v.vin ?? `Unit #${v.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-20 shrink-0">
              <input 
                type="number" 
                min="1" 
                value={interest.quantity} 
                onChange={(e) => update(i, { quantity: parseInt(e.target.value) || 1 })}
                className="w-full h-9 rounded-md bg-foreground/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50 text-center"
              />
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} className="w-full border-dashed border-white/20 text-xs text-muted-foreground">
        <Plus className="w-3 h-3 mr-1" /> Add another
      </Button>
    </div>
  );
}
