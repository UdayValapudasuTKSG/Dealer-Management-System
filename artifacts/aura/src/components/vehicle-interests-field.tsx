import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, Plus, GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StyledSelect } from "@/components/ui/styled-select";

function VehicleCascade({
  interest,
  onChange,
  vehicles,
}: {
  interest: any;
  onChange: (interest: any) => void;
  vehicles: any[];
}) {
  const legacyVehicle = useMemo(
    () => vehicles.find(v => v.id === interest.vehicleId),
    [interest.vehicleId, vehicles],
  );
  const [make, setMake] = useState<string>(interest.make || legacyVehicle?.make || "");
  const [model, setModel] = useState<string>(interest.model || legacyVehicle?.model || "");
  const [year, setYear] = useState<string>(String(interest.modelYear || legacyVehicle?.year || ""));
  const [variant, setVariant] = useState<string>(interest.variant || legacyVehicle?.trim || legacyVehicle?.variant || "");
  const [color, setColor] = useState<string>(interest.color || legacyVehicle?.exteriorColor || "");

  useEffect(() => {
    if (!legacyVehicle || interest.make) return;
    setMake(legacyVehicle.make || "");
    setModel(legacyVehicle.model || "");
    setYear(String(legacyVehicle.year || ""));
    setVariant(legacyVehicle.trim || legacyVehicle.variant || "");
    setColor(legacyVehicle.exteriorColor || "");
  }, [legacyVehicle, interest.make]);

  const makes = useMemo(() => Array.from(new Set(vehicles.map(v => v.make).filter(Boolean))).sort(), [vehicles]);

  const models = useMemo(() => {
    if (!make) return [];
    return Array.from(new Set(vehicles.filter(v => v.make === make).map(v => v.model).filter(Boolean))).sort();
  }, [vehicles, make]);

  const variants = useMemo(() => {
    if (!make || !model) return [];
    return Array.from(new Set(vehicles.filter(v => v.make === make && v.model === model).map(v => v.trim || v.variant || "Base"))).sort();
  }, [vehicles, make, model]);

  const years = useMemo(() => {
    if (!make || !model || !variant) return [];
    return Array.from(new Set(vehicles.filter(v =>
      v.make === make && v.model === model &&
      (v.trim || v.variant || "Base") === variant
    ).map(v => v.year))).sort((a, b) => Number(b) - Number(a));
  }, [vehicles, make, model, variant]);

  const colors = useMemo(() => {
    if (!make || !model || !variant || !year) return [];
    return Array.from(new Set(vehicles.filter(v => v.make === make && v.model === model &&
      (v.trim || v.variant || "Base") === variant && String(v.year) === year
    ).map(v => v.exteriorColor || "Unspecified"))).sort();
  }, [vehicles, make, model, variant, year]);

  const onMakeChange = (newMake: string) => {
    setMake(newMake);
    setModel("");
    setYear("");
    setVariant("");
    setColor("");
    onChange({ make: newMake, model: "", modelYear: null, variant: null, color: null, unitPrice: null });
  };

  const onModelChange = (newModel: string) => {
    setModel(newModel);
    setVariant("");
    setYear("");
    setColor("");
    onChange({ make, model: newModel, modelYear: null, variant: null, color: null, unitPrice: null });
  };

  const onVariantChange = (newVariant: string) => {
    setVariant(newVariant);
    setYear("");
    setColor("");
    onChange({ make, model, modelYear: null, variant: newVariant, color: null, unitPrice: null });
  };

  const onYearChange = (newYear: string) => {
    setYear(newYear);
    setColor("");
    onChange({ make, model, modelYear: Number(newYear), variant, color: null, unitPrice: null });
  };

  const onColorChange = (newColor: string) => {
    setColor(newColor);
    const representative = vehicles.find(v =>
      v.make === make &&
      v.model === model &&
      (v.trim || v.variant || "Base") === variant &&
      String(v.year) === year &&
      (v.exteriorColor || "Unspecified") === newColor
    );
    onChange({
      make, model, modelYear: Number(year),
      variant,
      color: newColor === "Unspecified" ? null : newColor,
      unitPrice: representative?.price ?? null,
    });
  };

  const selectClass = "flex-1 h-9 rounded-md bg-foreground/[0.04] border border-white/10 px-3 text-sm focus:border-primary/50 min-w-0 disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <StyledSelect value={make} onValueChange={onMakeChange} options={[{ value: "", label: "Brand..." }, ...makes.map(m => ({ value: m, label: m }))]} className={selectClass} />
        <StyledSelect value={model} onValueChange={onModelChange} disabled={!make} options={[{ value: "", label: "Model..." }, ...models.map(m => ({ value: m, label: m }))]} className={selectClass} />
        <StyledSelect value={variant} onValueChange={onVariantChange} disabled={!model} options={[{ value: "", label: "Version / Trim..." }, ...variants.map(v => ({ value: v, label: v }))]} className={selectClass} />
        <StyledSelect value={year} onValueChange={onYearChange} disabled={!variant} options={[{ value: "", label: "Year..." }, ...years.map(y => ({ value: String(y), label: String(y) }))]} className={selectClass} />
        <StyledSelect value={color} onValueChange={onColorChange} disabled={!year} options={[{ value: "", label: "Color..." }, ...colors.map(c => ({ value: c, label: c }))]} className={selectClass} />
      </div>
      {interest.modelYear && interest.unitPrice != null && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-muted-foreground">
          <span>Year <strong className="text-foreground">{interest.modelYear}</strong></span>
          <span>Unit / VIN <strong className="text-foreground">Assigned at allocation</strong></span>
          <span>Unit price <strong className="text-foreground">GYD {Number(interest.unitPrice).toLocaleString()}</strong></span>
          <span>Line total <strong className="text-foreground">GYD {(Number(interest.unitPrice) * Number(interest.quantity || 1)).toLocaleString()}</strong></span>
        </div>
      )}
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

  const add = () => {
    onChange(JSON.stringify([...interests, {
      make: "", model: "", modelYear: null, variant: null,
      color: null, unitPrice: null, quantity: 1, position: interests.length,
    }]));
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
                interest={interest}
                onChange={(spec) => update(i, spec)}
                vehicles={vehicles}
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
