import { useState, useRef } from "react";
import { Link } from "wouter";
import { motion, useScroll, useTransform, AnimatePresence } from "framer-motion";
import { ArrowRight, Loader2, CircleCheck, TerminalSquare, Inbox, Activity, BarChart4, ChevronRight, Fingerprint, Network } from "lucide-react";
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
import { useCreateEnquiry } from "@workspace/api-client-react";

const noiseBg = { backgroundImage: `url(${import.meta.env.BASE_URL}noise.svg)` };

function DemoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    dealershipName: "",
    role: "",
    size: "",
    comments: "",
  });
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createEnquiry = useCreateEnquiry();
  const submitting = createEnquiry.isPending;

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const detailLines = [
      "B2B demo request from AURA OS landing page.",
      `Dealership: ${form.dealershipName}`,
      form.role ? `Role: ${form.role}` : null,
      form.size ? `Volume: ${form.size} units/month` : null,
      form.comments ? `Challenges: ${form.comments}` : null,
    ].filter(Boolean);
    try {
      await createEnquiry.mutateAsync({
        data: {
          name: form.name.trim(),
          email: form.email.trim(),
          source: "website",
          comments: detailLines.join("\n"),
        },
      });
      setDone(true);
    } catch {
      setError("Something went wrong sending your request. Please try again.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setDone(false);
      }}
    >
      <DialogContent className="max-w-lg bg-black border-white/10 text-white">
        {done ? (
          <div className="py-10 text-center space-y-4">
            <CircleCheck className="w-12 h-12 text-primary mx-auto" />
            <DialogTitle className="text-2xl font-light tracking-tight">
              Request received
            </DialogTitle>
            <p className="text-sm text-zinc-400 max-w-sm mx-auto leading-relaxed">
              Our enterprise team will reach out shortly to schedule your personalized AURA OS demonstration.
            </p>
            <Button onClick={() => onOpenChange(false)} className="rounded-full px-8 mt-4 bg-primary text-white hover:bg-primary/90">
              Close
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-light tracking-tight text-white">
                Request a demo
              </DialogTitle>
              <DialogDescription className="text-zinc-400">
                See how AURA OS can transform your dealership's operations.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid grid-cols-2 gap-4 mt-4">
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">Full name *</Label>
                <Input required value={form.name} onChange={set("name")} placeholder="Jane Doe" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-500" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">Work Email *</Label>
                <Input required type="email" value={form.email} onChange={set("email")} placeholder="jane@dealership.com" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-500" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-zinc-300">Dealership Name *</Label>
                <Input required value={form.dealershipName} onChange={set("dealershipName")} placeholder="Acme Motors" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-500" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-zinc-300">Role</Label>
                <Input value={form.role} onChange={set("role")} placeholder="Dealer Principal" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-500" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">Fleet Size / Volume</Label>
                <select 
                  value={form.size} 
                  onChange={set("size")}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="" className="bg-zinc-900 text-white">Select volume</option>
                  <option value="1-50" className="bg-zinc-900 text-white">1-50 units / month</option>
                  <option value="51-200" className="bg-zinc-900 text-white">51-200 units / month</option>
                  <option value="200+" className="bg-zinc-900 text-white">200+ units / month</option>
                </select>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-zinc-300">What are you looking to solve?</Label>
                <Textarea value={form.comments} onChange={set("comments")} placeholder="Tell us about your current challenges..." rows={3} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-500" />
              </div>
              {error && (
                <p className="col-span-2 text-sm text-red-400">{error}</p>
              )}
              <Button
                type="submit"
                disabled={submitting || !form.name.trim() || !form.email.trim() || !form.dealershipName.trim()}
                className="col-span-2 rounded-full h-12 mt-2 bg-primary text-white hover:bg-primary/90 transition-colors"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  "Request Demo"
                )}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Stylized Glass UI Mockups
function PipelineWidget() {
  return (
    <div className="w-full max-w-sm rounded-2xl bg-white/[0.03] backdrop-blur-xl border border-white/10 p-5 shadow-2xl overflow-hidden relative">
      <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 rounded-full blur-[40px] pointer-events-none" />
      <div className="flex items-center justify-between mb-6 relative z-10">
        <h4 className="text-sm font-medium tracking-wide text-white flex items-center gap-2">
          <TerminalSquare className="w-4 h-4 text-primary" /> Active Pipeline
        </h4>
        <span className="text-[10px] uppercase tracking-widest text-primary bg-primary/10 px-2 py-1 rounded-full">Live</span>
      </div>
      <div className="space-y-3 relative z-10">
        {[
          { name: "John Smith", vehicle: "Porsche Taycan", stage: "Test Drive", time: "2h ago", val: "$92k" },
          { name: "Sarah Connor", vehicle: "BMW i4", stage: "Finance", time: "4h ago", val: "$65k" },
          { name: "Michael Chen", vehicle: "Range Rover", stage: "Appraisal", time: "1d ago", val: "$110k" },
        ].map((lead, i) => (
          <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.05] transition-colors cursor-pointer group">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-xs font-medium text-zinc-300">
                {lead.name.split(' ').map(n => n[0]).join('')}
              </div>
              <div>
                <p className="text-xs font-medium text-white">{lead.name}</p>
                <p className="text-[10px] text-zinc-400 font-mono mt-0.5 max-w-[110px] truncate">{lead.vehicle}</p>
              </div>
            </div>
            <div className="text-right pl-4 shrink-0">
              <p className="text-xs font-medium text-white group-hover:text-primary transition-colors">{lead.val}</p>
              <p className="text-[10px] text-zinc-500 font-mono mt-0.5 whitespace-nowrap">{lead.stage}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-4 border-t border-white/[0.05] flex justify-between items-center relative z-10">
        <span className="text-[10px] font-mono text-zinc-500">24 active leads</span>
        <button className="text-xs font-medium text-primary hover:text-white transition-colors flex items-center gap-1">
          View all <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function StatsWidget() {
  return (
    <div className="grid grid-cols-2 gap-3 w-full max-w-sm">
      <div className="col-span-2 rounded-2xl bg-white/[0.03] backdrop-blur-xl border border-white/10 p-5 shadow-lg relative overflow-hidden">
        <div className="absolute bottom-0 left-0 w-full h-1/2 bg-gradient-to-t from-primary/10 to-transparent pointer-events-none" />
        <p className="text-[11px] uppercase tracking-widest text-zinc-400 font-mono mb-1">Monthly Revenue</p>
        <div className="flex items-baseline gap-2">
          <h3 className="text-2xl font-light text-white">$2.4M</h3>
          <span className="text-xs font-medium text-emerald-400">+14.2%</span>
        </div>
        <div className="h-8 mt-4 flex items-end gap-1.5 opacity-80">
          {[40, 65, 45, 80, 55, 90, 75].map((h, i) => (
            <div key={i} className="flex-1 bg-white/20 rounded-t-sm transition-all duration-500 hover:bg-primary" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
      
      <div className="rounded-2xl bg-white/[0.03] backdrop-blur-xl border border-white/10 p-4 shadow-lg flex flex-col justify-between aspect-square">
        <p className="text-[11px] uppercase tracking-widest text-zinc-400 font-mono">Conversion</p>
        <div>
          <h3 className="text-2xl font-light text-white">18.5%</h3>
          <p className="text-xs font-medium text-emerald-400 mt-1">Top Quartile</p>
        </div>
      </div>
      
      <div className="rounded-2xl bg-white/[0.03] backdrop-blur-xl border border-white/10 p-4 shadow-lg flex flex-col justify-between aspect-square">
        <p className="text-[11px] uppercase tracking-widest text-zinc-400 font-mono">AI Intake</p>
        <div>
          <h3 className="text-2xl font-light text-white">142</h3>
          <p className="text-xs text-zinc-400 mt-1 font-mono">Auto-qualified</p>
        </div>
      </div>
    </div>
  );
}

function RoleBadge({ role, icon: Icon, delay }: { role: string, icon: any, delay: number }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay }}
      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] backdrop-blur-md px-3 py-1.5 shadow-lg shadow-black/20"
    >
      <Icon className="w-3.5 h-3.5 text-primary" />
      <span className="text-[11px] uppercase tracking-wider font-mono text-zinc-300">{role}</span>
    </motion.div>
  );
}

export default function Landing() {
  const [demoOpen, setDemoOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"]
  });

  // Parallax transforms for various elements
  const heroY = useTransform(scrollYProgress, [0, 0.2], [0, 150]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.15], [1, 0]);
  const navBg = useTransform(scrollYProgress, [0, 0.05], ["rgba(0,0,0,0)", "rgba(10,12,16,0.8)"]);
  const navBorder = useTransform(scrollYProgress, [0, 0.05], ["rgba(255,255,255,0)", "rgba(255,255,255,0.1)"]);

  return (
    <div ref={containerRef} className="bg-[#050A10] text-white selection:bg-primary/30 selection:text-white min-h-[200vh]">
      
      {/* Dynamic Nav */}
      <motion.header
        style={{ backgroundColor: navBg, borderColor: navBorder }}
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-10 h-20 backdrop-blur-xl border-b transition-colors duration-300"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl overflow-hidden ring-1 ring-white/20 bg-black/40 flex items-center justify-center">
            <img src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="AURA" className="h-full w-full object-cover" />
          </div>
          <span className="text-lg font-bold tracking-tight text-white font-sans flex items-baseline">
            AURA<span className="text-primary text-base font-mono ml-0.5">.OS</span>
          </span>
        </div>
        <nav className="hidden md:flex items-center gap-8 font-mono text-[11px] uppercase tracking-widest">
          <a href="#platform" className="text-white/60 hover:text-white transition-colors">Platform</a>
          <a href="#modules" className="text-white/60 hover:text-white transition-colors">Modules</a>
          <a href="#enterprise" className="text-white/60 hover:text-white transition-colors">Enterprise</a>
        </nav>
        <div className="flex items-center gap-4">
          <Link href="/command-center" className="hidden sm:block text-xs font-mono text-zinc-400 hover:text-white uppercase tracking-wider">
            Sign In
          </Link>
          <button
            onClick={() => setDemoOpen(true)}
            className="h-9 px-5 rounded-full bg-white text-black text-sm font-semibold hover:bg-zinc-200 transition-colors"
          >
            Request Demo
          </button>
        </div>
      </motion.header>

      {/* Hero Section */}
      <section className="relative h-[100dvh] w-full flex items-center overflow-hidden">
        {/* Deep space background with subtle glows */}
        <div className="absolute inset-0 bg-[#050A10]" />
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/4 w-[30rem] h-[30rem] bg-blue-500/10 rounded-full blur-[150px] pointer-events-none" />
        <div style={noiseBg} className="absolute inset-0 bg-repeat opacity-20 pointer-events-none mix-blend-overlay"></div>
        
        <motion.div 
          style={{ y: heroY, opacity: heroOpacity }}
          className="relative z-20 w-full max-w-7xl mx-auto px-6 md:px-10 pt-20"
        >
          <div className="max-w-4xl mx-auto text-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] backdrop-blur-md mb-8"
            >
              <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
              <span className="text-[10px] uppercase tracking-widest font-mono text-zinc-300">The Dealership Operating System</span>
            </motion.div>
            
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
              className="text-5xl md:text-7xl lg:text-[6rem] font-light tracking-tight text-white leading-[1.05]"
            >
              Run your entire <br />
              <span className="font-semibold bg-gradient-to-r from-white via-white to-zinc-500 bg-clip-text text-transparent">dealership on AURA.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="mt-8 max-w-2xl mx-auto text-lg md:text-xl text-zinc-400 font-light leading-relaxed"
            >
              Ditch the fragmented tools. AURA unifies your pipeline, finance, service, and operations into a single, intelligent command center designed for modern auto retail.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="mt-12 flex flex-wrap items-center justify-center gap-4"
            >
              <button
                onClick={() => setDemoOpen(true)}
                className="group inline-flex items-center gap-2 h-14 px-8 rounded-full bg-white text-black text-base font-semibold shadow-lg shadow-white/10 hover:bg-zinc-200 transition-all duration-300"
              >
                Get a Demo
                <ArrowRight className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" />
              </button>
              <Link
                href="/command-center"
                className="inline-flex items-center gap-2 h-14 px-8 rounded-full border border-white/10 text-white text-base font-medium backdrop-blur-md hover:bg-white/5 transition-all duration-300"
              >
                Sign In to Command Center
              </Link>
            </motion.div>
          </div>
          
          {/* Floating UI Elements */}
          <div className="mt-24 relative flex justify-center perspective-1000">
            <motion.div
              initial={{ opacity: 0, y: 40, rotateX: 10 }}
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              transition={{ duration: 1, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-20"
            >
              <PipelineWidget />
            </motion.div>
            <motion.div
              initial={{ opacity: 0, x: -260, y: 20, rotateY: 10 }}
              animate={{ opacity: 1, x: -330, y: -40, rotateY: 15 }}
              transition={{ duration: 1, delay: 0.7, ease: [0.16, 1, 0.3, 1] }}
              className="absolute top-0 z-10 hidden lg:block"
            >
              <StatsWidget />
            </motion.div>
          </div>
        </motion.div>
      </section>

      {/* Proof points */}
      <section className="py-24 relative z-20 bg-[#03060A] border-y border-white/[0.03]">
        <div className="max-w-7xl mx-auto px-6 md:px-10">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 divide-y md:divide-y-0 md:divide-x divide-white/[0.05]">
            {[
              { stat: "100%", label: "Modules Unified", desc: "Sales, Service, F&I" },
              { stat: "24/7", label: "AI Intake Agent", desc: "Never miss a lead" },
              { stat: "-40%", label: "Admin Time", desc: "Automated workflows" },
              { stat: "Real-time", label: "Global Visiblity", desc: "Multi-branch reporting" },
            ].map((p, i) => (
              <motion.div 
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="flex flex-col items-center text-center pt-8 md:pt-0"
              >
                <h3 className="text-4xl font-light text-white mb-2">{p.stat}</h3>
                <p className="text-xs uppercase tracking-widest font-mono text-primary mb-1">{p.label}</p>
                <p className="text-sm text-zinc-500">{p.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature Narrative - Sticky Scroll */}
      <section id="platform" className="relative">
        <div className="sticky top-0 h-screen flex items-center bg-[#050A10] overflow-hidden">
          <div style={noiseBg} className="absolute inset-0 bg-repeat opacity-10 pointer-events-none mix-blend-overlay"></div>
          
          <div className="max-w-7xl mx-auto px-6 md:px-10 w-full grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24">
            <div className="flex flex-col justify-center">
              <motion.div
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.7 }}
              >
                <span className="text-sm font-mono uppercase tracking-[0.2em] text-primary mb-6 block">01 / Command Center</span>
                <h2 className="text-4xl md:text-5xl font-light tracking-tight mb-6">
                  Absolute visibility across your enterprise.
                </h2>
                <p className="text-lg text-zinc-400 font-light leading-relaxed mb-8">
                  Get a pulse on your entire dealership group in real-time. AURA's Command Center aggregates data from sales, service, and finance into actionable insights, helping dealer principals make decisions faster.
                </p>
                
                <div className="space-y-4">
                  {[
                    { icon: BarChart4, text: "Live KPI dashboards and forecasting" },
                    { icon: Network, text: "Multi-branch consolidation" },
                    { icon: Fingerprint, text: "Role-based access control (RBAC)" },
                  ].map((feat, i) => (
                    <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                      <feat.icon className="w-5 h-5 text-primary" />
                      <span className="text-sm text-zinc-300 font-medium">{feat.text}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>
            
            <div className="hidden lg:flex items-center justify-center relative perspective-1000">
              <motion.div
                initial={{ opacity: 0, rotateY: -15, scale: 0.9 }}
                whileInView={{ opacity: 1, rotateY: -5, scale: 1 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.8 }}
                className="relative z-20 w-full max-w-lg"
              >
                <div className="w-full aspect-video rounded-2xl bg-white/[0.03] backdrop-blur-2xl border border-white/10 shadow-2xl p-2 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-full h-1/2 bg-primary/10 blur-[50px] pointer-events-none" />
                  <div className="w-full h-full rounded-xl bg-black/40 border border-white/[0.05] p-4 flex flex-col gap-4">
                    <div className="flex justify-between items-center pb-2 border-b border-white/5">
                      <div className="h-4 w-24 bg-white/10 rounded" />
                      <div className="flex gap-2">
                        <div className="h-4 w-12 bg-white/10 rounded" />
                        <div className="h-4 w-12 bg-white/10 rounded" />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      {[1,2,3].map(i => (
                        <div key={i} className="h-20 bg-white/5 rounded-lg border border-white/5 p-3 flex flex-col justify-end">
                          <div className="h-2 w-1/2 bg-white/20 rounded mb-1" />
                          <div className="h-4 w-3/4 bg-white/40 rounded" />
                        </div>
                      ))}
                    </div>
                    <div className="flex-1 bg-white/5 rounded-lg border border-white/5 mt-2" />
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      {/* Modules - Alternating Layout */}
      <section id="modules" className="py-32 bg-[#020408] relative z-10">
        <div className="max-w-7xl mx-auto px-6 md:px-10">
          <div className="text-center max-w-3xl mx-auto mb-24">
            <h2 className="text-3xl md:text-5xl font-light tracking-tight mb-6">A unified ecosystem.</h2>
            <p className="text-lg text-zinc-400 font-light">Every department works from the same source of truth. No more data silos, no more lost opportunities.</p>
          </div>

          <div className="space-y-32">
            {/* Sales */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
              <div className="order-2 lg:order-1 relative perspective-1000">
                <div className="w-full max-w-md mx-auto aspect-square rounded-full bg-primary/5 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 blur-[80px]" />
                <div className="relative z-10 p-6 rounded-3xl bg-white/[0.02] border border-white/[0.05] backdrop-blur-xl shadow-2xl">
                  <div className="flex gap-2 mb-6">
                    <RoleBadge role="Sales Agent" icon={Activity} delay={0.1} />
                    <RoleBadge role="F&I Manager" icon={TerminalSquare} delay={0.2} />
                  </div>
                  <div className="space-y-3">
                    {[
                      { stage: "New Lead", source: "WhatsApp AI", status: "Auto-replied" },
                      { stage: "Test Drive", source: "Walk-in", status: "Scheduled Today" },
                      { stage: "Negotiation", source: "Web", status: "Quote Sent" },
                    ].map((item, i) => (
                      <div key={i} className="p-4 rounded-xl bg-black/40 border border-white/5 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-white">{item.stage}</p>
                          <p className="text-[10px] text-zinc-500 font-mono mt-1">Source: {item.source}</p>
                        </div>
                        <span className="text-[10px] uppercase tracking-wider text-primary bg-primary/10 px-2 py-1 rounded">
                          {item.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="order-1 lg:order-2">
                <span className="text-sm font-mono uppercase tracking-[0.2em] text-primary mb-4 block">Sales & Finance</span>
                <h3 className="text-3xl md:text-4xl font-light mb-6">Close deals faster with intelligent pipelines.</h3>
                <p className="text-zinc-400 leading-relaxed mb-8">
                  From first touch via our WhatsApp AI intake agent to final finance approval, AURA keeps deals moving forward. Gate stages ensure compliance, while automated quotes and LOS integrations streamline F&I.
                </p>
                <ul className="space-y-3 font-mono text-xs text-zinc-300">
                  <li className="flex gap-3"><span className="text-primary">→</span> Multi-channel lead aggregation</li>
                  <li className="flex gap-3"><span className="text-primary">→</span> Digital appraisals & inventory matching</li>
                  <li className="flex gap-3"><span className="text-primary">→</span> Native finance application tracking</li>
                </ul>
              </div>
            </div>

            {/* Service */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
              <div>
                <span className="text-sm font-mono uppercase tracking-[0.2em] text-primary mb-4 block">Service & Parts</span>
                <h3 className="text-3xl md:text-4xl font-light mb-6">Maximize workshop throughput.</h3>
                <p className="text-zinc-400 leading-relaxed mb-8">
                  Keep bays full and customers informed. AURA's service module connects bookings, job cards, and parts inventory seamlessly, driving fixed ops profitability.
                </p>
                <ul className="space-y-3 font-mono text-xs text-zinc-300">
                  <li className="flex gap-3"><span className="text-primary">→</span> Integrated appointment scheduling</li>
                  <li className="flex gap-3"><span className="text-primary">→</span> Technician efficiency tracking</li>
                  <li className="flex gap-3"><span className="text-primary">→</span> Automated part requisition alerts</li>
                </ul>
              </div>
              <div className="relative">
                <div className="aspect-[4/3] rounded-3xl overflow-hidden border border-white/10 shadow-2xl relative">
                  <img src={`${import.meta.env.BASE_URL}images/service_bay.png`} alt="Modern Service Bay" className="w-full h-full object-cover opacity-80 mix-blend-luminosity" />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#020408] via-transparent to-transparent" />
                  
                  {/* Floating overlay */}
                  <div className="absolute bottom-6 left-6 right-6 p-4 rounded-xl bg-white/[0.05] backdrop-blur-xl border border-white/10 flex items-center justify-between">
                    <div>
                      <p className="text-xs uppercase font-mono text-zinc-400 mb-1">Active Job Card</p>
                      <p className="text-sm font-medium text-white">#JC-8492 • Porsche 911</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-emerald-400 mb-1">In Progress</p>
                      <p className="text-xs font-mono text-zinc-400">Bay 04</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section id="enterprise" className="py-32 relative overflow-hidden bg-primary/5">
        <div style={noiseBg} className="absolute inset-0 bg-repeat opacity-20 mix-blend-overlay"></div>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        
        <div className="max-w-4xl mx-auto px-6 text-center relative z-10">
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-light tracking-tight mb-8">
            Ready to upgrade your operating system?
          </h2>
          <p className="text-xl text-zinc-400 font-light mb-12">
            Join the forward-thinking dealer groups running on AURA.
          </p>
          <button
            onClick={() => setDemoOpen(true)}
            className="h-16 px-10 rounded-full bg-primary text-white text-lg font-semibold shadow-[0_0_40px_rgba(13,59,102,0.4)] hover:bg-primary/90 transition-all duration-300"
          >
            Request Enterprise Demo
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 border-t border-white/[0.05] bg-[#020408] text-center">
        <div className="flex justify-center items-center gap-2 mb-6">
           <img src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="AURA" className="h-6 w-6 opacity-50 grayscale" />
           <span className="text-sm font-bold tracking-tight text-white/50">AURA<span className="font-mono text-xs">.OS</span></span>
        </div>
        <p className="text-zinc-600 text-xs font-mono">© {new Date().getFullYear()} AURA Technologies. Dealer Management System.</p>
      </footer>

      <DemoDialog open={demoOpen} onOpenChange={setDemoOpen} />
    </div>
  );
}
