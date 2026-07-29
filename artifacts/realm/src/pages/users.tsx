import { useState } from "react";
import { useListPlatformUsers } from "@workspace/api-client-react";
import { Users as UsersIcon, Search, Calendar } from "lucide-react";
import { Input } from "@/components/ui/input";

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 ${className || ""}`}>
      {children}
    </div>
  );
}

function PageHeader({ eyebrow, title, subtitle, right }: { eyebrow?: string; title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 flex-wrap">
      <div>
        {eyebrow && <SectionLabel>{eyebrow}</SectionLabel>}
        <h1 className="mt-2 font-serif text-4xl tracking-tight text-zinc-900">{title}</h1>
        {subtitle && (
          <p className="mt-2 text-[13.5px] text-zinc-600 max-w-2xl leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </div>
  );
}

export default function Users() {
  const { data: users, isLoading } = useListPlatformUsers();
  const [search, setSearch] = useState("");

  const filtered = (users ?? []).filter(u => 
    (u.name || "").toLowerCase().includes(search.toLowerCase()) ||
    (u.email || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="w-full px-4 md:px-6 py-8 space-y-6 font-sans">
      <PageHeader 
        eyebrow="USERS" 
        title="Platform Users" 
        subtitle="Identities managed across the network." 
      />

      <div className="relative max-w-md glass rounded-xl overflow-hidden p-1 hover-elevate">
        <Search className="w-3.5 h-3.5 absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input 
          placeholder="Search by name or email..." 
          className="pl-10 bg-transparent border-none shadow-none focus-visible:ring-0 h-10 text-[13px] placeholder:text-zinc-400"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="glass rounded-2xl overflow-hidden hover-elevate">
        {isLoading && (
          <div className="p-12 text-center text-zinc-500 font-serif italic">Loading users...</div>
        )}
        
        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-zinc-500 font-serif italic">No users found.</div>
        ) : (
          <div className="divide-y divide-black/5">
            {filtered.map(user => (
              <div key={user.id} className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5 hover:bg-zinc-50/50 transition-colors">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  {user.imageUrl ? (
                    <img src={user.imageUrl} className="w-10 h-10 rounded-full object-cover border border-black/5 shrink-0 grayscale" alt="" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-500 font-serif text-lg border border-black/5 shrink-0">
                      {(user.name || user.email || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-serif text-[14.5px] tracking-tight text-zinc-900 truncate">{user.name || "Unknown User"}</h3>
                      {user.status === "active" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-700">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          </span>
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-zinc-50 px-2.5 py-0.5 text-[10.5px] font-medium text-zinc-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                          {user.status}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-zinc-500 truncate">{user.email}</div>
                  </div>
                </div>
                
                <div className="flex items-center gap-6 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 sm:ml-auto">
                  <div className="flex items-center gap-1.5">
                    <UsersIcon className="w-3.5 h-3.5" />
                    <span className="font-mono tracking-normal">{user.dealerCount} workspace{user.dealerCount === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 hidden sm:flex">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>Joined <span className="font-mono tracking-normal">{new Date(user.createdAt).toLocaleDateString()}</span></span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
