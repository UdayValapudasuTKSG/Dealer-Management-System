import { PageHero } from "@/components/layout/page-hero";
import { DutyFiling } from "@/components/gra/duty-filing";

export default function Gra() {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <PageHero
        eyebrow="Customs Desk"
        title="GRA Duty"
        accent="Filing"
        subtitle="Upload an import document — the X-ray scanner prepares the duty pack and routes it for approval."
      />
      <div className="w-full px-5 md:px-8 py-6 md:py-8">
        <DutyFiling />
      </div>
    </div>
  );
}
