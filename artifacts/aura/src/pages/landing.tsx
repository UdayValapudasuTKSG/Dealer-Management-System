import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { ArrowRight, Loader2, CircleCheck, CheckCircle2, MapPin, Map, Clock, Truck, ShieldCheck } from "lucide-react";
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

gsap.registerPlugin(ScrollTrigger);

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
      <DialogContent className="max-w-lg border-white/10 bg-zinc-950 text-white">
        {done ? (
          <div className="py-10 text-center space-y-4">
            <CircleCheck className="w-12 h-12 text-primary mx-auto" />
            <DialogTitle className="text-2xl font-light tracking-tight text-white">
              Enquiry received
            </DialogTitle>
            <p className="text-sm text-zinc-400 max-w-sm mx-auto leading-relaxed">
              Thank you — a confirmation email is on its way, and one of our
              advisors will be in touch shortly.
            </p>
            <Button onClick={() => onOpenChange(false)} className="rounded-full px-8 bg-primary hover:bg-primary/90 text-white">
              Done
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-light tracking-tight text-white">
                Enquire about a vehicle
              </DialogTitle>
              <DialogDescription className="text-zinc-400">
                Tell us what you're looking for and our team will reach out.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">Full name *</Label>
                <Input required value={form.name} onChange={set("name")} placeholder="Ama Mensah" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus-visible:ring-primary" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-zinc-300">Email</Label>
                <Input type="email" value={form.email} onChange={set("email")} placeholder="ama@email.com" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus-visible:ring-primary" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-zinc-300">Phone</Label>
                <Input value={form.phone} onChange={set("phone")} placeholder="+592 …" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus-visible:ring-primary" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">Vehicle of interest *</Label>
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
                <div className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">Model</div>
                    <div className="font-medium text-white">{selected.model}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">Version</div>
                    <div className="font-medium text-white">{selected.version}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">Color</div>
                    <div className="font-medium text-white">{selected.color}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">VIN</div>
                    <div className="font-medium text-white">{selected.vin ?? "On request"}</div>
                  </div>
                </div>
              )}
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">Preferred branch</Label>
                <Input value={form.preferredBranch} onChange={set("preferredBranch")} placeholder="e.g. Georgetown Showroom" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus-visible:ring-primary" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">Comments</Label>
                <Textarea value={form.comments} onChange={set("comments")} placeholder="Anything else we should know?" rows={3} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus-visible:ring-primary" />
              </div>
              {error && (
                <p className="col-span-2 text-sm text-destructive">{error}</p>
              )}
              <Button
                type="submit"
                disabled={submitting || !form.name.trim() || !form.vehicleId}
                className="col-span-2 rounded-full h-12 bg-primary hover:bg-primary/90 text-white"
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

const REGIONS = [
  { name: "Georgetown & Coast", time: "Same Day / 24 Hours", desc: "Express delivery for the capital and surrounding coastal areas." },
  { name: "Linden & Region 10", time: "24 - 48 Hours", desc: "Dedicated transport to the mining town and environs." },
  { name: "New Amsterdam & Berbice", time: "24 - 48 Hours", desc: "Reliable dispatch along the eastern corridor." },
  { name: "Anna Regina & Essequibo", time: "2 - 3 Days", desc: "Coordinated ferry and road transport to the Essequibo coast." },
  { name: "Bartica", time: "2 - 3 Days", desc: "Secure barge and road logistics to the gateway of the interior." },
  { name: "Lethem & Rupununi", time: "3 - 5 Days", desc: "Specialized interior transport via the Lethem trail." },
];

export default function Landing() {
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const heroContentRef = useRef<HTMLDivElement>(null);

  // Lenis smooth scroll + GSAP scrubbed scroll effects
  useEffect(() => {
    const lenis = new Lenis({ lerp: 0.09 });
    lenis.on("scroll", ScrollTrigger.update);
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);
    const restoreLagSmoothing = () => gsap.ticker.lagSmoothing(500, 33);

    const ctx = gsap.context(() => {
      // Pinned hero: video slowly zooms while the copy drifts up and fades
      gsap.to(videoRef.current, {
        scale: 1.18,
        ease: "none",
        scrollTrigger: {
          trigger: heroRef.current,
          start: "top top",
          end: "+=60%",
          scrub: true,
          pin: true,
          pinSpacing: true,
        },
      });
      gsap.to(heroContentRef.current, {
        yPercent: -22,
        opacity: 0,
        ease: "none",
        scrollTrigger: {
          trigger: heroRef.current,
          start: "top top",
          end: "+=45%",
          scrub: true,
        },
      });
      // Parallax drift on showcase imagery
      gsap.utils
        .toArray<HTMLElement>("[data-parallax]")
        .forEach((el) => {
          const depth = Number(el.dataset.parallax || 8);
          gsap.fromTo(
            el,
            { yPercent: depth },
            {
              yPercent: -depth,
              ease: "none",
              scrollTrigger: {
                trigger: el,
                start: "top bottom",
                end: "bottom top",
                scrub: true,
              },
            },
          );
        });
    }, rootRef);

    return () => {
      ctx.revert();
      gsap.ticker.remove(raf);
      lenis.destroy();
      restoreLagSmoothing();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="bg-black text-white selection:bg-primary/30 selection:text-white min-h-[100dvh] font-sans"
    >
      {/* Hero Section */}
      <section
        ref={heroRef}
        className="relative h-[100dvh] w-full overflow-hidden"
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          loop
          playsInline
          poster={`${import.meta.env.BASE_URL}vehicles/aura_porsche_taycan.png`}
          className="absolute inset-0 w-full h-full object-cover will-change-transform"
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
        <div
          ref={heroContentRef}
          className="relative z-20 h-full flex flex-col justify-center px-6 md:px-10 lg:px-14 pt-20 will-change-transform"
        >
          <div className="max-w-4xl">
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="text-5xl md:text-7xl lg:text-[5.5rem] font-light tracking-tight text-white leading-[1.05]"
            >
              Your dream car. <br />
              <span className="font-semibold text-[#B4D6E3]">Delivered anywhere in Guyana.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.35 }}
              className="mt-8 max-w-xl text-lg md:text-xl text-zinc-300 font-light leading-relaxed"
            >
              5,000+ vehicles delivered on time and fully insured — from our Georgetown showroom to the farthest reaches of the Rupununi.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.5 }}
              className="mt-12 flex flex-wrap items-center gap-4"
            >
              <Link
                href="/command-center"
                className="group inline-flex items-center gap-2 h-14 px-8 rounded-full bg-primary text-white text-base font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all duration-300"
              >
                Go to Daily Briefing
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

      {/* The Delivery Standard - Track Record */}
      <section className="py-32 bg-zinc-950 relative border-b border-white/5 overflow-hidden">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-20 items-center">
            <motion.div
              initial={{ opacity: 0, x: -40 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.8 }}
            >
              <h2 className="text-sm font-bold uppercase tracking-[0.3em] text-[#7F9DB1] mb-6">Proven Track Record</h2>
              <h3 className="text-4xl md:text-5xl font-light tracking-tight leading-tight text-white mb-8">
                Over 5,000 successful <br />
                <span className="font-semibold text-[#B4D6E3]">deliveries completed.</span>
              </h3>
              <p className="text-lg text-zinc-400 font-light leading-relaxed mb-10">
                AURA Motors isn't just a showroom. We operate a sophisticated nationwide logistics network that ensures your vehicle arrives in pristine condition, whether you are in central Georgetown or the deep interior.
              </p>
              
              <div className="grid grid-cols-2 gap-8">
                <div>
                  <div className="text-4xl font-light text-white mb-2">5K+</div>
                  <div className="text-sm text-zinc-500 uppercase tracking-widest font-medium">Vehicles Delivered</div>
                </div>
                <div>
                  <div className="text-4xl font-light text-white mb-2">10</div>
                  <div className="text-sm text-zinc-500 uppercase tracking-widest font-medium">Regions Covered</div>
                </div>
                <div>
                  <div className="text-4xl font-light text-white mb-2">100%</div>
                  <div className="text-sm text-zinc-500 uppercase tracking-widest font-medium">Insured Transit</div>
                </div>
                <div>
                  <div className="text-4xl font-light text-white mb-2">24/7</div>
                  <div className="text-sm text-zinc-500 uppercase tracking-widest font-medium">Logistics Support</div>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.8 }}
              className="relative"
            >
              <div className="aspect-[4/5] rounded-3xl overflow-hidden shadow-2xl shadow-primary/10 border border-white/5">
                <img 
                  src={`${import.meta.env.BASE_URL}images/delivery.png`} 
                  alt="AURA Motors delivery" 
                  data-parallax="6"
                  className="w-full h-[112%] object-cover will-change-transform"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
              </div>
              <div className="absolute -bottom-10 -left-10 w-2/3 aspect-square rounded-3xl overflow-hidden shadow-2xl border-8 border-zinc-950 hidden md:block">
                <img 
                  src={`${import.meta.env.BASE_URL}images/handshake.png`} 
                  alt="Client taking delivery of a new vehicle" 
                  data-parallax="10"
                  className="w-full h-[115%] object-cover will-change-transform"
                />
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Nationwide Coverage & Speed */}
      <section className="py-32 bg-black relative overflow-hidden">
        {/* Subtle blueprint grid backdrop */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage:
              "radial-gradient(ellipse 80% 70% at 50% 40%, black, transparent)",
            WebkitMaskImage:
              "radial-gradient(ellipse 80% 70% at 50% 40%, black, transparent)",
          }}
        />
        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14 relative">
          <div className="text-center max-w-3xl mx-auto mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.8 }}
            >
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
                <Truck className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-3xl md:text-4xl font-light tracking-tight text-white mb-6">Unmatched Delivery Speed</h2>
              <p className="text-lg text-zinc-400 font-light leading-relaxed">
                We've mastered Guyanese logistics. From RO-RO ferries to the Linden-Lethem trail, we guarantee secure, timely delivery to every corner of the country.
              </p>
            </motion.div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {REGIONS.map((region, i) => (
              <motion.div
                key={region.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="relative p-8 rounded-2xl bg-white/[0.03] backdrop-blur-xl border border-white/10 hover:border-primary/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-all duration-500 group overflow-hidden"
              >
                {/* Warm inner glow, AURA red */}
                <div
                  aria-hidden
                  className="absolute inset-0 pointer-events-none opacity-60 group-hover:opacity-100 transition-opacity duration-500"
                  style={{
                    background:
                      "radial-gradient(120% 90% at 15% 110%, rgba(229,9,20,0.28), rgba(229,9,20,0.08) 45%, transparent 70%)",
                  }}
                />
                <div className="relative">
                  <div className="flex items-center justify-between mb-5">
                    <h4 className="text-xl font-medium text-white transition-colors">{region.name}</h4>
                    <MapPin className="w-5 h-5 text-primary opacity-60 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <span className="inline-flex items-center gap-2 mb-4 rounded-full border border-white/15 bg-black/40 px-4 py-1.5 text-sm font-medium text-white/90 shadow-[0_0_20px_rgba(229,9,20,0.15)]">
                    <Clock className="w-3.5 h-3.5 text-primary" />
                    {region.time}
                  </span>
                  <p className="text-zinc-400 text-sm leading-relaxed">{region.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>


      {/* Call to Action & Footer */}
      <section className="py-24 bg-black text-center relative">
        <div className="max-w-3xl mx-auto px-6 relative z-10">
          <h2 className="text-3xl md:text-4xl font-light tracking-tight text-white mb-8">Ready to experience AURA?</h2>
          <div className="flex justify-center gap-4">
            <button
              onClick={() => setEnquiryOpen(true)}
              className="inline-flex items-center gap-2 h-14 px-8 rounded-full bg-primary text-white text-base font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all duration-300"
            >
              Start Your Journey
            </button>
            <Link
              href="/command-center"
              className="inline-flex items-center gap-2 h-14 px-8 rounded-full border border-white/20 text-white text-base font-medium hover:bg-white/10 transition-all duration-300"
            >
              Enter Daily Briefing <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      <footer className="py-12 border-t border-white/10 bg-black text-center text-zinc-500 text-sm">
        <p>© {new Date().getFullYear()} AURA Motors Guyana. All rights reserved.</p>
      </footer>

      <EnquiryDialog open={enquiryOpen} onOpenChange={setEnquiryOpen} />
    </div>
  );
}
