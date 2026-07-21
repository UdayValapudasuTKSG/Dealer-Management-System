import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { ArrowRight, Loader2, CircleCheck, Play, Briefcase, FileSignature, CarFront, CheckCircle2, Workflow } from "lucide-react";
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

const BRAND_CARS = [
  { brand: "Tesla", file: "cutout_tesla_side.png" },
  { brand: "BYD", file: "cutout_byd_side.png" },
  { brand: "FOTON", file: "cutout_foton_side.png" },
];

const STAGES = [
  {
    id: "lead",
    title: "Intelligence Captured",
    desc: "Aura identifies high-intent leads across WhatsApp, social, and web. Immediate AI triage ensures zero missed opportunities.",
    icon: Workflow,
    video: "office_operations.mp4",
  },
  {
    id: "engage",
    title: "Advisor Engagement",
    desc: "A single pane of glass for all customer context. The advisor orchestrates the relationship with full history at their fingertips.",
    icon: Briefcase,
    video: "pipeline_sales_floor.mp4",
  },
  {
    id: "testdrive",
    title: "The Experience",
    desc: "Seamless test drive scheduling, digital liability waivers, and real-time fleet tracking. The BYD Seal leaves the showroom, the deal stays on track.",
    icon: CarFront,
    video: "red_car_leaving_showroom.mp4",
  },
  {
    id: "finance",
    title: "Finance & Approvals",
    desc: "Instant credit checks, automated GRA compliance, and one-click documentation. Turning days of paperwork into minutes.",
    icon: FileSignature,
    video: "finance_signing.mp4",
  },
  {
    id: "delivery",
    title: "Delivery & Handover",
    desc: "The keys are handed over — from a Tesla sedan to a FOTON workhorse. Automated post-sale workflows trigger service reminders, CRM updates, and satisfaction surveys.",
    icon: CheckCircle2,
    video: "customer_handover.mp4",
  },
];

export default function Landing() {
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const carRef = useRef<HTMLImageElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const prefersReducedMotion = useReducedMotion();

  // GSAP Scroll Experience
  useEffect(() => {
    if (prefersReducedMotion) return;

    const lenis = new Lenis({ lerp: 0.08 });
    lenis.on("scroll", ScrollTrigger.update);
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);
    const restoreLagSmoothing = () => gsap.ticker.lagSmoothing(500, 33);

    const ctx = gsap.context(() => {
      // Pin the car and animate it along the vertical path
      const stages = gsap.utils.toArray<HTMLElement>('.pipeline-stage');
      
      stages.forEach((stage, i) => {
        const video = stage.querySelector('video');
        const content = stage.querySelector('.stage-content');
        
        // Stage enter/exit animations
        gsap.fromTo(content, 
          { opacity: 0, y: 50 },
          {
            opacity: 1, 
            y: 0,
            scrollTrigger: {
              trigger: stage,
              start: "top center",
              end: "center center",
              scrub: true,
            }
          }
        );

        if (video) {
          ScrollTrigger.create({
            trigger: stage,
            start: "top center",
            end: "bottom center",
            onEnter: () => video.play().catch(() => {}),
            onLeave: () => video.pause(),
            onEnterBack: () => video.play().catch(() => {}),
            onLeaveBack: () => video.pause(),
          });
        }
      });

      // Car progress along path
      if (carRef.current && containerRef.current) {
        gsap.to(carRef.current, {
          y: () => containerRef.current!.offsetHeight - window.innerHeight,
          ease: "none",
          scrollTrigger: {
            trigger: containerRef.current,
            start: "top top",
            end: "bottom bottom",
            scrub: 1,
            onUpdate: (self) => {
              const active = Math.min(2, Math.floor(self.progress * 3));
              carRef.current
                ?.querySelectorAll<HTMLImageElement>(".brand-car")
                .forEach((img) => {
                  img.style.opacity =
                    Number(img.dataset.brandIndex) === active ? "1" : "0";
                });
            },
          }
        });
      }

      // Parallax hero
      const heroVideo = document.querySelector('.hero-video');
      const heroContent = document.querySelector('.hero-content');
      
      if (heroVideo && heroContent) {
        gsap.to(heroVideo, {
          scale: 1.15,
          ease: "none",
          scrollTrigger: {
            trigger: ".hero-section",
            start: "top top",
            end: "bottom top",
            scrub: true,
          }
        });
        
        gsap.to(heroContent, {
          yPercent: 30,
          opacity: 0,
          ease: "none",
          scrollTrigger: {
            trigger: ".hero-section",
            start: "top top",
            end: "bottom top",
            scrub: true,
          }
        });
      }

    }, rootRef);

    return () => {
      ctx.revert();
      gsap.ticker.remove(raf);
      lenis.destroy();
      restoreLagSmoothing();
    };
  }, [prefersReducedMotion]);

  return (
    <div
      ref={rootRef}
      className="bg-black text-white selection:bg-primary/30 selection:text-white min-h-[100dvh] font-sans overflow-x-hidden"
    >
      {/* Navigation */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.2 }}
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-10 lg:px-14 h-24 pointer-events-none"
      >
        <div className="flex items-center gap-3 pointer-events-auto">
          <span className="text-xl font-bold tracking-[0.2em] uppercase text-white drop-shadow-[0_0_15px_rgba(169,113,66,0.5)]">
            AURA OS
          </span>
        </div>
        <nav className="hidden md:flex items-center gap-8 bg-black/40 backdrop-blur-xl px-8 py-3 rounded-full border border-white/10 pointer-events-auto shadow-2xl">
          {QUICK_LINKS.map((l) => (
            <Link
              key={l.name}
              href={l.href}
              className="text-xs font-semibold tracking-[0.1em] uppercase text-zinc-300 hover:text-white transition-colors"
            >
              {l.name}
            </Link>
          ))}
          <div className="w-[1px] h-4 bg-white/20"></div>
          <Link
            href="/command-center"
            className="text-xs font-bold tracking-[0.1em] uppercase text-primary hover:text-primary-foreground transition-colors"
          >
            Sign In
          </Link>
        </nav>
      </motion.header>

      {/* Hero Section */}
      <section className="hero-section relative h-[100dvh] w-full overflow-hidden flex items-center justify-center">
        <video
          autoPlay
          muted
          loop
          playsInline
          poster={`${import.meta.env.BASE_URL}vehicles/aura_tesla_model_y.png`}
          className="hero-video absolute inset-0 w-full h-full object-cover opacity-60"
        >
          <source
            src={`${import.meta.env.BASE_URL}videos/white_luxury_car_showroom_turntable.mp4`}
            type="video/mp4"
          />
        </video>
        
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black z-10" />

        <div className="hero-content relative z-20 text-center px-6 max-w-5xl mx-auto mt-20">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <h1 className="text-5xl md:text-7xl lg:text-[6rem] font-light tracking-tighter text-white leading-[1.1] mb-8">
              The Agentic OS for <br />
              <span className="font-medium text-transparent bg-clip-text bg-gradient-to-r from-gold via-[#D4A373] to-primary">Premium Dealerships.</span>
            </h1>
            <p className="text-xl md:text-2xl text-zinc-400 font-light tracking-wide max-w-2xl mx-auto mb-12 leading-relaxed">
              From lead capture to handover, run your entire dealership on a single, intelligent platform. Experience the pipeline.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
              <Link
                href="/command-center"
                className="group relative inline-flex items-center justify-center gap-3 h-16 px-10 rounded-full bg-primary/10 border border-primary text-white text-sm font-bold uppercase tracking-[0.15em] overflow-hidden transition-all hover:bg-primary"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]" />
                Enter Workspace
                <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
            <p className="mt-10 text-[11px] font-semibold uppercase tracking-[0.35em] text-zinc-500">
              Tesla · BYD · FOTON
            </p>
          </motion.div>
        </div>
        
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5, duration: 1 }}
          className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-3"
        >
          <span className="hidden [@media(min-height:800px)]:inline text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Scroll to explore</span>
          <div className="hidden [@media(min-height:800px)]:block w-[1px] h-16 bg-gradient-to-b from-primary/50 to-transparent" />
        </motion.div>
      </section>

      {/* The Journey - Scroll Experience */}
      <section ref={containerRef} className="relative w-full bg-black py-32">
        {/* Animated Path / Track */}
        <div className="absolute left-[15%] md:left-1/2 top-0 bottom-0 w-[2px] -translate-x-1/2 bg-white/5 z-0">
          <div className="absolute top-0 bottom-0 left-0 w-full bg-gradient-to-b from-primary via-gold to-primary opacity-50 blur-[4px]" />
        </div>

        {/* Traveling Car */}
        {!prefersReducedMotion && (
          <div 
            ref={carRef}
            className="absolute left-[15%] md:left-1/2 top-[5%] -translate-x-1/2 -translate-y-1/2 z-30 w-32 md:w-48 pointer-events-none will-change-transform"
          >
            <div className="relative rotate-90">
              <div className="absolute inset-0 bg-primary/30 blur-2xl rounded-full scale-150" />
              {BRAND_CARS.map((car, i) => (
                <img
                  key={car.brand}
                  src={`${import.meta.env.BASE_URL}vehicles/${car.file}`}
                  alt={`${car.brand} vehicle`}
                  className={`brand-car w-full drop-shadow-2xl transition-opacity duration-700 ${
                    i === 0 ? "relative z-10 opacity-100" : "absolute inset-0 z-10 opacity-0"
                  }`}
                  data-brand-index={i}
                />
              ))}
            </div>
          </div>
        )}

        <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14 relative z-10">
          <div className="space-y-[30vh] md:space-y-[50vh] py-[20vh]">
            {STAGES.map((stage, idx) => {
              const isEven = idx % 2 === 0;
              return (
                <div key={stage.id} className="pipeline-stage relative flex flex-col md:flex-row items-center gap-12 md:gap-24 min-h-[60vh]">
                  {/* Content */}
                  <div className={`stage-content flex-1 ${isEven ? 'md:text-right md:order-1' : 'md:text-left md:order-2'} ml-[30%] md:ml-0`}>
                    <div className={`flex items-center gap-4 mb-6 ${isEven ? 'md:justify-end' : 'md:justify-start'}`}>
                      <div className="w-12 h-12 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center backdrop-blur-sm text-primary">
                        <stage.icon className="w-5 h-5" />
                      </div>
                      <span className="text-xs font-bold uppercase tracking-[0.2em] text-primary">Stage 0{idx + 1}</span>
                    </div>
                    <h2 className="text-3xl md:text-5xl font-light tracking-tight text-white mb-6">
                      {stage.title}
                    </h2>
                    <p className="text-lg text-zinc-400 font-light leading-relaxed max-w-xl md:ml-auto">
                      {stage.desc}
                    </p>
                  </div>

                  {/* Media */}
                  <div className={`flex-1 w-full max-w-lg ${isEven ? 'md:order-2' : 'md:order-1'} hidden md:block`}>
                    <div className="relative aspect-video rounded-2xl overflow-hidden border border-white/10 glass-panel">
                      <div className="absolute inset-0 bg-primary/10 mix-blend-color z-10 pointer-events-none" />
                      <video
                        muted
                        loop
                        playsInline
                        className="absolute inset-0 w-full h-full object-cover"
                        src={`${import.meta.env.BASE_URL}videos/${stage.video}`}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="relative py-32 bg-zinc-950 overflow-hidden border-t border-white/5">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>
        <div className="absolute inset-0 bg-gradient-to-t from-primary/5 to-transparent pointer-events-none" />
        
        <div className="max-w-4xl mx-auto px-6 text-center relative z-10">
          <h2 className="text-4xl md:text-6xl font-light tracking-tight text-white mb-8">
            The standard is set. <br />
            <span className="font-medium text-gold">Own the operation.</span>
          </h2>
          <p className="text-xl text-zinc-400 font-light mb-12 max-w-2xl mx-auto">
            AURA Dealership OS is available exclusively to certified automotive partners in Guyana. Elevate your showroom experience today.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
            <Link
              href="/command-center"
              className="inline-flex items-center justify-center gap-2 h-14 px-8 rounded-full bg-primary text-white text-sm font-bold uppercase tracking-wider shadow-[0_0_30px_rgba(169,113,66,0.3)] hover:bg-primary/90 hover:scale-105 transition-all"
            >
              Sign In to Workspace
            </Link>
            <button
              onClick={() => setEnquiryOpen(true)}
              className="inline-flex items-center justify-center gap-2 h-14 px-8 rounded-full border border-white/20 bg-white/5 backdrop-blur-md text-white text-sm font-bold uppercase tracking-wider hover:bg-white/10 transition-all"
            >
              Make an Enquiry
            </button>
          </div>
        </div>
      </section>

      <EnquiryDialog open={enquiryOpen} onOpenChange={setEnquiryOpen} />
    </div>
  );
}
