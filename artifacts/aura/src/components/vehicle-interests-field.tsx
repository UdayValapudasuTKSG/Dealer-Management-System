import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, Plus, GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";

function VehicleCascade({
  vehicleId,
  onChange,
  vehicles,
  selectedIds,
}: {
  vehicleId: number | null;
  onChange: (vehicleId: number | null) => void;
  vehicles: any[];
  selectedIds: number[];
}) {
  const currentVehicle = useMemo(() => vehicles.find(v => v.id === vehicleId), [vehicleId, vehicles]);

  const [make, setMake] = useState<string>(currentVehicle?.make || "");
  const [model, setModel] = useState<string>(currentVehicle?.model || "");
  const [variant, setVariant] = useState<string>(currentVehicle?.trim || currentVehicle?.variant || "");
  const [color, setColor] = useState<string>(currentVehicle?.exteriorColor || "");

  useEffect(() => {
    if (currentVehicle) {
      setMake(currentVehicle.make || "");
      setModel(currentVehicle.model || "");
      setVariant(currentVehicle.trim || currentVehicle.variant || "");
      setColor(currentVehicle.exteriorColor || "");
    }
  }, [currentVehicle]);

  const makes = useMemo(() => Array.from(new Set(vehicles.map(v => v.make).filter(Boolean))).sort(), [vehicles]);

  const models = useMemo(() => {
    if (!make) return [];
    return Array.from(new Set(vehicles.filter(v => v.make === make).map(v => v.model).filter(Boolean))).sort();
  }, [vehicles, make]);

  const variants = useMemo(() => {
    if (!make || !model) return [];
    return Array.from(new Set(vehicles.filter(v => v.make === make && v.model === model).map(v => v.trim || v.variant || "Base"))).sort();
  }, [vehicles, make, model]);

  const colors = useMemo(() => {
    if (!make || !model || !variant) return [];
    return Array.from(new Set(vehicles.filter(v => v.make === make && v.model === model && (v.trim || v.variant || "Base") === variant).map(v => v.exteriorColor || "Unspecified"))).sort();
  }, [vehicles, make, model, variant]);

  const units = useMemo(() => {
    if (!make || !model || !variant || !color) return [];
    return vehicles.filter(v =>
      v.make === make &&
      v.model === model &&
      (v.trim || v.variant || "Base") === variant &&
      (v.exteriorColor || "Unspecified") === color &&
      (!selectedIds.includes(v.id) || v.id === vehicleId)
    );
  }, [vehicles, make, model, variant, color, selectedIds, vehicleId]);

  const onMakeChange = (newMake: string) => {
    setMake(newMake);
    setModel("");
    setVariant("");
    setColor("");
    onChange(null);
  };

  const onModelChange = (newModel: string) => {
    setModel(newModel);
    setVariant("");
    setColor("");
    onChange(null);
  };

  const onVariantChange = (newVariant: string) => {
    setVariant(newVariant);
    setColor("");
    onChange(null);
  };

  const onColorChange = (newColor: string) => {
    setColor(newColor);
    onChange(null);
    const matchedUnits = vehicles.filter(v =>
      v.make === make &&
      v.model === model &&
      (v.trim || v.variant || "Base") === variant &&
      (v.exteriorColor || "Unspecified") === newColor &&
      (!selectedIds.includes(v.id) || v.id === vehicleId)
    );
    if (matchedUnits.length === 1) {
      onChange(matchedUnits[0].id);
    }
  };

  const selectClass = "flex-1 h-9 rounded-md bg-foreground/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50 min-w-0 disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex items-center gap-2">
        <select value={make} onChange={e => onMakeChange(e.target.value)} className={selectClass}>
          <option value="">Make...</option>
          {makes.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={model} onChange={e => onModelChange(e.target.value)} disabled={!make} className={selectClass}>
          <option value="">Model...</option>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={variant} onChange={e => onVariantChange(e.target.value)} disabled={!model} className={selectClass}>
          <option value="">Variant...</option>
          {variants.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <select value={color} onChange={e => onColorChange(e.target.value)} disabled={!variant} className={selectClass}>
          <option value="">Color...</option>
          {colors.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={vehicleId || ""} onChange={e => onChange(parseInt(e.target.value) || null)} disabled={!color || units.length === 0} className={selectClass}>
          <option value="">{units.length === 0 && color ? "No units available" : "Unit..."}</option>
          {units.map(u => (
            <option key={u.id} value={u.id}>
              {u.vin ? `VIN ${u.vin}` : `Unit #${u.id}`} ({u.status})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

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

  const selectedIds = useMemo(() => interests.map((i: any) => i.vehicleId).filter(Boolean), [interests]);

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
            <div className="flex-1 min-w-0">
              <VehicleCascade
                vehicleId={interest.vehicleId}
                onChange={(id) => update(i, { vehicleId: id })}
                vehicles={vehicles}
                selectedIds={selectedIds}
              />
            </div>
            <div className="w-20 shrink-0">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">Qty</label>
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
        <Plus className="w-3 h-3 mr-1" /> Add vehicle interest
      </Button>
    </div>
  );
}
