import { useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowRight, Sparkles, Loader2, CircleCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { VehicleCascade } from "@/components/vehicle-cascade";
import { useListEnquiryVehicles } from "@workspace/api-client-react";

const QUICK_LINKS = [
  { name: "Showroom", href: "/inventory" },
  // Shelved for now (page + route kept):
  // { name: "Deals", href: "/deals" },
  { name: "Finance", href: "/finance" },
  { name: "Service", href: "/service" },
];

function EnquiryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    vehicleId: "",
    preferredBranch: "",
    comments: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: vehicles, isLoading: vehiclesLoading } =
    useListEnquiryVehicles();
  const selected = (vehicles ?? []).find(
    (v) => String(v.id) === form.vehicleId,
  );

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.vehicleId) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        source: "website",
        vehicleId: Number(form.vehicleId),
      };
      for (const k of ["name", "email", "phone", "preferredBranch", "comments"] as const) {
        if (form[k].trim()) body[k] = form[k].trim();
      }
      const res = await fetch(`${import.meta.env.BASE_URL}api/enquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Request failed");
      setDone(true);
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setDone(false);
          setError(null);
        }
      }}
    >
      <DialogContent className="max-w-lg">
        {done ? (
          <div className="py-10 text-center space-y-4">
            <CircleCheck className="w-12 h-12 text-primary mx-auto" />
            <DialogTitle className="text-2xl font-light tracking-tight">
              Enquiry received
            </DialogTitle>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
              Thank you — a confirmation email is on its way, and one of our
              advisors will be in touch shortly.
            </p>
            <Button onClick={() => onOpenChange(false)} className="rounded-full px-8">
              Done
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-light tracking-tight">
                Enquire about a vehicle
              </DialogTitle>
              <DialogDescription>
                Tell us what you're looking for and our team will reach out.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1.5">
                <Label>Full name *</Label>
                <Input required value={form.name} onChange={set("name")} placeholder="Ama Mensah" />
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={form.email} onChange={set("email")} placeholder="ama@email.com" />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={form.phone} onChange={set("phone")} placeholder="+233 …" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Vehicle of interest *</Label>
                <VehicleCascade
                  vehicles={(vehicles ?? []).map((v) => ({
                    id: v.id,
                    brand: v.make,
                    model: v.model,
                    version: v.version,
                    color: v.color,
                    year: v.year,
                    vin: v.vin ?? null,
                    price: v.price,
                  }))}
                  loading={vehiclesLoading}
                  showSummary={false}
                  onResolve={(v) =>
                    setForm((f) => ({ ...f, vehicleId: v ? String(v.id) : "" }))
                  }
                />
              </div>
              {selected && (
                <div className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Model</div>
                    <div className="font-medium">{selected.model}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Version</div>
                    <div className="font-medium">{selected.version}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Color</div>
                    <div className="font-medium">{selected.color}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">VIN</div>
                    <div className="font-medium">{selected.vin ?? "On request"}</div>
                  </div>
                </div>
              )}
              <div className="col-span-2 space-y-1.5">
                <Label>Preferred branch</Label>
                <Input value={form.preferredBranch} onChange={set("preferredBranch")} placeholder="e.g. Accra Showroom" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Comments</Label>
                <Textarea value={form.comments} onChange={set("comments")} placeholder="Anything else we should know?" rows={3} />
              </div>
              {error && (
                <p className="col-span-2 text-sm text-destructive">{error}</p>
              )}
              <Button
                type="submit"
                disabled={submitting || !form.name.trim() || !form.vehicleId}
                className="col-span-2 rounded-full h-12"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  "Send enquiry"
                )}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Landing() {
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  return (
    <div className="relative h-screen w-full overflow-hidden bg-black">
      <video
        autoPlay
        muted
        loop
        playsInline
        poster={`${import.meta.env.BASE_URL}vehicles/aura_porsche_taycan.png`}
        className="absolute inset-0 w-full h-full object-cover"
      >
        <source
          src={`${import.meta.env.BASE_URL}videos/white_luxury_car_showroom_turntable.mp4`}
          type="video/mp4"
        />
      </video>

      {/* Cinematic legibility gradients */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/50 z-10" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-transparent to-transparent z-10" />

      {/* Top bar */}
      <motion.header
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="relative z-20 flex items-center justify-between px-6 md:px-10 lg:px-14 h-20"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-primary" />
          <span className="text-xl font-bold tracking-tight text-white">
            AURA<span className="text-primary">.OS</span>
          </span>
        </div>
        <nav className="hidden md:flex items-center gap-8">
          {QUICK_LINKS.map((l) => (
            <Link
              key={l.name}
              href={l.href}
              className="text-sm font-medium tracking-wide text-white/70 hover:text-white transition-colors"
            >
              {l.name}
            </Link>
          ))}
        </nav>
      </motion.header>

      {/* Hero content */}
      <div className="relative z-20 h-[calc(100vh-5rem)] flex flex-col justify-center px-6 md:px-10 lg:px-14">
        <div className="max-w-4xl">
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-xs md:text-sm font-bold uppercase tracking-[0.3em] text-white/70 mb-6"
          >
            Agentic Dealership OS
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="text-5xl md:text-7xl lg:text-8xl font-light tracking-tight text-white leading-[0.95]"
          >
            The showroom,
            <br />
            <span className="font-semibold text-primary drop-shadow-[0_0_12px_rgba(232,168,119,0.3)]">orchestrated.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.35 }}
            className="mt-8 max-w-xl text-lg md:text-xl text-white/75 font-light leading-relaxed"
          >
            Inventory, leads, deals, finance and service — run by a fleet of AI
            agents, with you in command of every decision that matters.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.5 }}
            className="mt-12 flex flex-wrap items-center gap-4"
          >
            <Link
              href="/command-center"
              className="group inline-flex items-center gap-2 h-14 px-8 rounded-full bg-primary text-white text-base font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all duration-300 glow-brand"
            >
              Enter Command Center
              <ArrowRight className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" />
            </Link>
            <Link
              href="/inventory"
              className="inline-flex items-center gap-2 h-14 px-8 rounded-full border border-white/30 text-white text-base font-medium backdrop-blur-sm hover:border-white/60 hover:bg-white/5 transition-all duration-300"
            >
              Explore the Showroom
            </Link>
            <button
              onClick={() => setEnquiryOpen(true)}
              className="inline-flex items-center gap-2 h-14 px-8 rounded-full border border-primary/50 text-white text-base font-medium backdrop-blur-sm hover:bg-primary/15 hover:border-primary transition-all duration-300"
            >
              Enquire about a vehicle
            </button>
          </motion.div>
        </div>
      </div>

      <EnquiryDialog open={enquiryOpen} onOpenChange={setEnquiryOpen} />
    </div>
  );
}
