import { Link } from "wouter";
import { ArrowRight, Settings } from "lucide-react";
import { PageHero } from "@/components/layout/page-hero";
import { useSettingsSections } from "@/components/settings-nav";

export default function SettingsHub() {
  const sections = useSettingsSections();

  return (
    <>
      <PageHero
        eyebrow="Configuration"
        icon={Settings}
        title="Dealership"
        accent="Settings"
        subtitle="Everything that shapes how this dealership runs — team, roles, pipeline rules, taxes and messaging."
      />
      <div className="w-full px-5 md:px-8 pb-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {sections.map((s) => {
            const Icon = s.icon;
            return (
              <Link
                key={s.href}
                href={s.href}
                className="group relative rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-foreground/[0.03]"
              >
                <div className="flex items-start gap-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/25 text-gold transition-transform group-hover:scale-105">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold tracking-tight text-foreground">
                        {s.name}
                      </h3>
                      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0 group-hover:text-primary" />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground leading-snug">
                      {s.description}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
