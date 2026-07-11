import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";

const QUICK_LINKS = [
  { name: "Showroom", href: "/inventory" },
  { name: "Deals", href: "/deals" },
  { name: "Finance", href: "/finance" },
  { name: "Service", href: "/service" },
];

export default function Landing() {
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
            <span className="font-semibold">orchestrated.</span>
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
              href="/pipeline"
              className="group inline-flex items-center gap-2 h-14 px-8 rounded-full bg-primary text-white text-base font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all duration-300"
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
          </motion.div>
        </div>
      </div>
    </div>
  );
}
