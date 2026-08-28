import { useRoute, Link } from "wouter";
import { useGetTeamMember } from "@workspace/api-client-react";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  CarFront,
  CircleUserRound,
  Loader2,
  Mail,
  Trophy,
  Users,
} from "lucide-react";
import { Page } from "@/components/layout/page";
import { cn } from "@/lib/utils";
import { formatGuyanaDate } from "@/lib/format";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  assigned: "Assigned",
  contacted: "Contacted",
  qualified: "Qualified",
  test_drive: "Test Drive",
  back_order: "Back Order",
  decision: "Decision",
  engaged: "Engaged",
  converted: "Converted",
  lost: "Lost",
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-3xl font-light mt-2">{value}</div>
    </div>
  );
}

export default function TeamProfile() {
  const [, params] = useRoute("/team/:id");
  const id = params ? Number(params.id) : NaN;

  const { data: member, isLoading, isError } = useGetTeamMember(id);

  if (isLoading) {
    return (
      <Page>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </Page>
    );
  }

  if (isError || !member) {
    return (
      <Page>
        <div className="text-center py-32 space-y-4">
          <div className="text-lg font-semibold">Team member not found</div>
          <Link
            href="/pipeline"
            className="text-primary hover:underline text-sm"
          >
            Back to Pipeline
          </Link>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <Link
        href="/pipeline"
        className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors mb-5"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Pipeline
      </Link>

      {/* Identity */}
      <div className="rounded-3xl border border-white/10 bg-foreground/[0.03] p-6 md:p-8 flex flex-wrap items-center gap-6">
        {member.imageUrl ? (
          <img
            src={member.imageUrl}
            alt={member.name}
            className="w-20 h-20 rounded-full object-cover ring-2 ring-primary/40"
          />
        ) : (
          <div className="w-20 h-20 rounded-full bg-primary/15 text-primary flex items-center justify-center text-2xl font-semibold ring-2 ring-primary/40">
            {initials(member.name) || <CircleUserRound className="w-8 h-8" />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight truncate">
            {member.name}
          </h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {member.roleName && (
              <span className="inline-flex items-center text-[11px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2.5 py-1 rounded-full">
                {member.roleName}
              </span>
            )}
            <span
              className={cn(
                "inline-flex items-center text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ring-1",
                member.status === "active"
                  ? "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30"
                  : "bg-foreground/[0.06] text-muted-foreground ring-white/10",
              )}
            >
              {member.status}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground flex-wrap">
            {member.email && (
              <a
                href={`mailto:${member.email}`}
                className="inline-flex items-center gap-1.5 hover:text-primary transition-colors break-all"
              >
                <Mail className="w-3.5 h-3.5" />
                {member.email}
              </a>
            )}
            <span>
              Member since{" "}
              {formatGuyanaDate(member.memberSince)}
            </span>
            {member.lastLoginAt && (
              <span>
                Last active{" "}
                {formatGuyanaDate(member.lastLoginAt)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Workload */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
        <Stat
          icon={<Users className="w-3.5 h-3.5" />}
          label="Open leads"
          value={member.openLeads}
        />
        <Stat
          icon={<CarFront className="w-3.5 h-3.5" />}
          label="Total leads"
          value={member.totalLeads}
        />
        <Stat
          icon={<Trophy className="w-3.5 h-3.5" />}
          label="Converted"
          value={member.wonLeads}
        />
        <Stat
          icon={<CalendarClock className="w-3.5 h-3.5" />}
          label="Upcoming drives"
          value={member.upcomingTestDrives}
        />
      </div>

      {/* Recent leads */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Recent leads
        </h2>
        {member.recentLeads.length === 0 ? (
          <div className="text-sm text-muted-foreground rounded-2xl border border-dashed border-white/10 p-8 text-center">
            No leads owned yet.
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 overflow-hidden divide-y divide-white/5">
            {member.recentLeads.map((l) => (
              <Link
                key={l.id}
                href={`/lead/${l.id}`}
                className="flex items-center gap-4 px-5 py-3.5 bg-foreground/[0.02] hover:bg-foreground/[0.05] transition-colors group"
              >
                <span className="flex-1 min-w-0 font-medium truncate">
                  {l.name}
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70 bg-foreground/[0.06] px-2.5 py-1 rounded-full shrink-0">
                  {STATUS_LABEL[l.status] ?? l.status}
                </span>
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                  {formatGuyanaDate(l.createdAt)}
                </span>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}
