import { useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, CircleCheck, CheckCircle2, ShieldCheck, Award, Users } from "lucide-react";
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
            <p className="text-sm text-zinc-400 max-w-sm mx-auto leading-relaxed">
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
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">Model</div>
                    <div className="font-medium">{selected.model}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">Version</div>
                    <div className="font-medium">{selected.version}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">Color</div>
                    <div className="font-medium">{selected.color}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">VIN</div>
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
    <div className="bg-black text-white selection:bg-primary/30 selection:text-white">
      {/* Hero Section */}
      <section className="relative h-[100dvh] w-full overflow-hidden">
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
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/60 z-10" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent z-10" />

        {/* Top bar */}
        <motion.header
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-6 md:px-10 lg:px-14 h-24"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <span className="font-bold text-white leading-none">A</span>
            </div>
            <span className="text-xl font-semibold tracking-widest uppercase text-white">
              AURA Motors
            </span>
          </div>
          <nav className="hidden md:flex items-center gap-8 bg-white/5 backdrop-blur-md px-8 py-3 rounded-full border border-white/10">
            {QUICK_LINKS.map((l) => (
              <Link
                key={l.name}
                href={l.href}
                className="text-sm font-medium tracking-wide text-white/80 hover:text-white transition-colors"
              >
                {l.name}
              </Link>
            ))}
          </nav>
        </motion.header>

        {/* Hero content */}
        <div className="relative z-20 h-full flex flex-col justify-center px-6 md:px-10 lg:px-14 pt-20">
          <div className="max-w-4xl">
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="text-5xl md:text-7xl lg:text-[5.5rem] font-light tracking-tight text-white leading-[1.05]"
            >
              Excellence in <br />
              <span className="font-semibold">every detail.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.35 }}
              className="mt-8 max-w-xl text-lg md:text-xl text-white/75 font-light leading-relaxed"
            >
              Discover an unparalleled automotive experience where world-class service meets an exceptional collection of luxury vehicles.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.5 }}
              className="mt-12 flex flex-wrap items-center gap-4"
            >
              <Link
                href="/inventory"
                className="group inline-flex items-center gap-2 h-14 px-8 rounded-full bg-primary text-white text-base font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all duration-300"
              >
                Explore the Collection
                <ArrowRight className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
              <button
                onClick={() => setEnquiryOpen(true)}
                className="inline-flex items-center gap-2 h-14 px-8 rounded-full border border-white/20 text-white text-base font-medium backdrop-blur-md hover:bg-white/10 hover:border-white/40 transition-all duration-300"
              >
                Make an Enquiry
              </button>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Trust & Achievements Section */}
      <section className="py-24 bg-zinc-950 relative border-b border-white/5">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14 relative z-10">
          <motion.div 
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8 }}
            className="grid grid-cols-1 md:grid-cols-3 gap-12 md:gap-8"
          >
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
                <ShieldCheck className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-4xl font-light tracking-tight mb-3">20+</h3>
              <p className="text-zinc-400 uppercase tracking-widest text-sm font-medium">Years of Excellence</p>
              <p className="text-sm text-zinc-500 mt-4 max-w-xs">Building lasting relationships through uncompromising integrity and service.</p>
            </div>
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
                <CheckCircle2 className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-4xl font-light tracking-tight mb-3">5,000+</h3>
              <p className="text-zinc-400 uppercase tracking-widest text-sm font-medium">Vehicles Delivered</p>
              <p className="text-sm text-zinc-500 mt-4 max-w-xs">A track record of fulfilling dreams and delivering exceptional automotive luxury.</p>
            </div>
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
                <Award className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-4xl font-light tracking-tight mb-3">#1</h3>
              <p className="text-zinc-400 uppercase tracking-widest text-sm font-medium">Premium Dealer</p>
              <p className="text-sm text-zinc-500 mt-4 max-w-xs">Recognized as the region's most trusted luxury automotive destination.</p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* The AURA Experience */}
      <section className="py-32 bg-black relative">
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-20 items-center">
            <motion.div
              initial={{ opacity: 0, x: -40 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.8 }}
            >
              <h2 className="text-sm font-bold uppercase tracking-[0.3em] text-primary mb-6">The Experience</h2>
              <h3 className="text-4xl md:text-5xl font-light tracking-tight leading-tight mb-8">
                More than a purchase.<br />
                <span className="font-semibold">A partnership.</span>
              </h3>
              <div className="space-y-6 text-lg text-zinc-400 font-light leading-relaxed">
                <p>
                  At AURA Motors, we believe acquiring a luxury vehicle should be as exceptional as the drive itself. Our dedicated team of advisors is committed to understanding your unique preferences, curating a selection that perfectly aligns with your lifestyle.
                </p>
                <p>
                  From your first step into our state-of-the-art showroom to the momentous day of delivery, every detail is orchestrated with precision, transparency, and a relentless pursuit of your satisfaction.
                </p>
              </div>
              
              <ul className="mt-10 space-y-4">
                {[
                  "Personalized consultations with expert advisors",
                  "Private, immersive test drive experiences",
                  "Transparent, tailored financial structuring",
                  "Unforgettable delivery ceremonies"
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-4 text-zinc-300">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.8 }}
              className="relative"
            >
              <div className="aspect-[4/5] rounded-3xl overflow-hidden shadow-2xl shadow-primary/10">
                <img 
                  src={`${import.meta.env.BASE_URL}images/handshake.png`} 
                  alt="AURA Motors advisor shaking hands with a client" 
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
              </div>
              <div className="absolute -bottom-10 -left-10 w-2/3 aspect-square rounded-3xl overflow-hidden shadow-2xl border-8 border-black hidden md:block">
                <img 
                  src={`${import.meta.env.BASE_URL}images/delivery.png`} 
                  alt="Client taking delivery of a new vehicle" 
                  className="w-full h-full object-cover"
                />
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* World Class Service */}
      <section className="py-32 bg-zinc-950">
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-20 items-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.8 }}
              className="order-2 lg:order-1"
            >
              <div className="aspect-[16/10] rounded-3xl overflow-hidden shadow-2xl shadow-primary/5 border border-white/5">
                <img 
                  src={`${import.meta.env.BASE_URL}images/service_bay.png`} 
                  alt="AURA Motors state of the art service bay" 
                  className="w-full h-full object-cover"
                />
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 40 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.8 }}
              className="order-1 lg:order-2"
            >
              <h2 className="text-sm font-bold uppercase tracking-[0.3em] text-primary mb-6">Service & Care</h2>
              <h3 className="text-4xl md:text-5xl font-light tracking-tight leading-tight mb-8">
                Maintained to <br />
                <span className="font-semibold">perfection.</span>
              </h3>
              <p className="text-lg text-zinc-400 font-light leading-relaxed mb-10">
                Our relationship extends far beyond the showroom floor. AURA Motors houses a world-class service facility staffed by factory-certified technicians who treat your vehicle with the reverence it deserves. Using only genuine parts and cutting-edge diagnostic equipment, we ensure your investment performs flawlessly for years to come.
              </p>
              
              <Link
                href="/service"
                className="inline-flex items-center gap-2 h-12 px-6 rounded-full border border-white/20 text-white text-sm font-medium hover:bg-white hover:text-black transition-all duration-300"
              >
                Book a Service
              </Link>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Our Story / Team */}
      <section className="py-32 bg-black">
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8 }}
            className="max-w-3xl mx-auto mb-16"
          >
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
              <Users className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-3xl md:text-4xl font-light tracking-tight mb-6">Driven by passion. Guided by integrity.</h2>
            <p className="text-lg text-zinc-400 font-light leading-relaxed">
              Founded on the principle that buying a luxury vehicle should be a celebration, AURA Motors has grown into a premier destination for automotive enthusiasts. Our team is united by a shared dedication to excellence, transparency, and creating unforgettable moments for our clients.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="aspect-[21/9] rounded-3xl overflow-hidden shadow-2xl relative"
          >
            <img 
              src={`${import.meta.env.BASE_URL}images/team_at_work.png`} 
              alt="The AURA Motors professional team" 
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-end justify-center pb-12">
              <Link
                href="/command-center"
                className="inline-flex items-center gap-2 text-white/50 hover:text-white transition-colors text-sm font-medium tracking-wide uppercase"
              >
                Enter Command Center <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 border-t border-white/10 bg-black text-center text-zinc-500 text-sm">
        <p>© {new Date().getFullYear()} AURA Motors. All rights reserved.</p>
      </footer>

      <EnquiryDialog open={enquiryOpen} onOpenChange={setEnquiryOpen} />
    </div>
  );
}
