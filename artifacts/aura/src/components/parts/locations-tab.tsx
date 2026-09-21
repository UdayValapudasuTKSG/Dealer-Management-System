import { useState } from "react";
import { Plus, MapPin, Pencil } from "lucide-react";
import { useGetLocations, useCreateLocation, useUpdateLocation, useGetBins, useCreateBin, useUpdateBin } from "@/hooks/use-parts-operations";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

function LocationDialog({ location, trigger }: { location?: any; trigger: React.ReactNode }) {
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const { toast } = useToast();
  const isEdit = !!location;

  return (
    <CreateRecordDialog
      title={isEdit ? "Edit Location" : "Add Location"}
      description={isEdit ? "Update location details." : "Create a new inventory location (branch or warehouse)."}
      pending={isEdit ? update.isPending : create.isPending}
      submitLabel={isEdit ? "Save changes" : "Create location"}
      trigger={trigger}
      fields={[
        { name: "name", label: "Location Name", type: "text", required: true, span: "full", defaultValue: location?.name },
        ...(!isEdit ? [{ name: "type", label: "Type", type: "select" as const, options: [{label: "Branch", value: "branch"}, {label: "Warehouse", value: "warehouse"}], span: "half" as const, defaultValue: "branch" }] : []),
        { name: "address", label: "Address", type: "text", span: "half", defaultValue: location?.address },
      ]}
      onSubmit={async (values) => {
        const payload = {
          name: String(values.name),
          ...(!isEdit ? { type: String(values.type) } : {}),
          ...(values.address ? { address: String(values.address) } : {}),
        };
        if (isEdit) {
          await update.mutateAsync({ id: location.id, data: payload });
          toast({ title: "Location updated" });
        } else {
          await create.mutateAsync(payload);
          toast({ title: "Location created" });
        }
      }}
    />
  );
}

function BinDialog({ bin, locationId, trigger }: { bin?: any; locationId: number; trigger: React.ReactNode }) {
  const create = useCreateBin();
  const update = useUpdateBin();
  const { toast } = useToast();
  const isEdit = !!bin;

  return (
    <CreateRecordDialog
      title={isEdit ? "Edit Bin" : "Add Bin"}
      description={isEdit ? "Update bin details." : "Create a new bin within this location."}
      pending={isEdit ? update.isPending : create.isPending}
      submitLabel={isEdit ? "Save changes" : "Create bin"}
      trigger={trigger}
      fields={[
        { name: "code", label: "Bin Code", type: "text", required: true, span: "half", defaultValue: bin?.code },
        { name: "description", label: "Description", type: "text", span: "half", defaultValue: bin?.description },
      ]}
      onSubmit={async (values) => {
        const payload = {
          ...(!isEdit ? { locationId } : {}),
          code: String(values.code),
          ...(values.description ? { description: String(values.description) } : {}),
        };
        if (isEdit) {
          await update.mutateAsync({ id: bin.id, data: payload });
          toast({ title: "Bin updated" });
        } else {
          await create.mutateAsync(payload);
          toast({ title: "Bin created" });
        }
      }}
    />
  );
}

export function LocationsTab() {
  const { data: locations, isLoading, isError, error } = useGetLocations();
  const [selectedLocation, setSelectedLocation] = useState<number | null>(null);
  
  const { data: bins, isLoading: binsLoading, isError: binsError } = useGetBins(selectedLocation ?? undefined);
  const updateLocation = useUpdateLocation();
  const updateBin = useUpdateBin();
  const { toast } = useToast();
  const toggle = async (record: any, kind: "location" | "bin") => {
    try {
      await (kind === "location" ? updateLocation : updateBin).mutateAsync({ id: record.id, data: { active: !record.active } });
      toast({ title: `${kind === "location" ? "Location" : "Bin"} ${record.active ? "deactivated" : "reactivated"}` });
    } catch (err) {
      toast({ title: "Status change failed", description: err instanceof Error ? err.message : "Could not update status.", variant: "destructive" });
    }
  };

  if (isLoading) {
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  }
  if (isError) return <div role="alert" className="p-4 rounded-2xl border border-destructive/30 text-destructive">Locations could not be loaded. {error instanceof Error ? error.message : "Please retry."}</div>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight">Locations</h2>
          <LocationDialog
            trigger={
              <Button size="sm" variant="outline" className="rounded-full gap-2 border-white/10">
                <Plus className="w-3.5 h-3.5" /> Add
              </Button>
            }
          />
        </div>
        <div className="space-y-2">
          {locations?.map((loc) => (
            <Card
              key={loc.id}
              className={`glass-panel border-none rounded-2xl cursor-pointer transition-colors ${selectedLocation === loc.id ? 'ring-1 ring-primary' : 'hover:bg-white/[0.08]'}`}
              onClick={() => setSelectedLocation(loc.id)}
            >
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <div className="font-semibold">{loc.name}</div>
                  <div className="text-xs text-muted-foreground capitalize flex items-center gap-2 mt-1">
                    <MapPin className="w-3 h-3" /> {loc.type}
                    {!loc.active && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                  </div>
                </div>
                <Button size="sm" variant="ghost" disabled={updateLocation.isPending} onClick={e => { e.stopPropagation(); void toggle(loc, "location"); }}>
                  {loc.active ? "Deactivate" : "Reactivate"}
                </Button>
                <LocationDialog
                  location={loc}
                  trigger={
                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ))}
          {(!locations || locations.length === 0) && (
            <div className="text-center py-10 text-sm text-muted-foreground border border-dashed border-white/10 rounded-2xl bg-white/[0.02]">
              No locations configured.
            </div>
          )}
        </div>
      </div>
      
      <div className="lg:col-span-2 space-y-4">
        {selectedLocation ? (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight">Bins</h2>
              <BinDialog
                locationId={selectedLocation}
                trigger={
                  <Button size="sm" variant="outline" className="rounded-full gap-2 border-white/10">
                    <Plus className="w-3.5 h-3.5" /> Add Bin
                  </Button>
                }
              />
            </div>
            {binsLoading ? (
              <div className="flex justify-center p-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : binsError ? (
              <div role="alert" className="p-4 text-destructive">Bins could not be loaded. Please retry.</div>
            ) : bins?.length ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {bins.map((bin) => (
                  <div key={bin.id} className="flex items-center justify-between p-3 rounded-xl bg-white/[0.03] border border-white/5">
                    <div>
                      <div className="font-medium text-sm">{bin.code}</div>
                      {!bin.active && <Badge variant="secondary">Inactive</Badge>}
                      {bin.description && <div className="text-xs text-muted-foreground mt-0.5">{bin.description}</div>}
                    </div>
                    <Button size="sm" variant="ghost" disabled={updateBin.isPending} onClick={() => void toggle(bin, "bin")}>
                      {bin.active ? "Deactivate" : "Reactivate"}
                    </Button>
                    <BinDialog
                      bin={bin}
                      locationId={selectedLocation}
                      trigger={
                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground">
                          <Pencil className="w-3 h-3" />
                        </Button>
                      }
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-10 text-sm text-muted-foreground border border-dashed border-white/10 rounded-2xl bg-white/[0.02]">
                No bins found in this location.
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center rounded-3xl border border-dashed border-white/10 bg-white/[0.02]">
            <MapPin className="w-8 h-8 text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground">Select a location to manage bins</p>
          </div>
        )}
      </div>
    </div>
  );
}
