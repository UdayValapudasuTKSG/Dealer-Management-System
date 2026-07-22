import { useState } from "react";
import { useListPlatformUsers } from "@workspace/api-client-react";
import { Users as UsersIcon, Search, Activity, Calendar } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function Users() {
  const { data: users, isLoading } = useListPlatformUsers();
  const [search, setSearch] = useState("");

  const filtered = (users ?? []).filter(u => 
    (u.name || "").toLowerCase().includes(search.toLowerCase()) ||
    (u.email || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-8 font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-serif tracking-wide">Platform Users</h1>
          <p className="text-xs text-muted-foreground mt-2 uppercase tracking-[0.15em]">Identities managed across the network</p>
        </div>
      </div>

      <div className="relative max-w-md glass-panel rounded-2xl overflow-hidden p-1">
        <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 opacity-50" />
        <Input 
          placeholder="Search by name or email..." 
          className="pl-11 bg-transparent border-none shadow-none focus-visible:ring-0 h-12 text-sm placeholder:text-muted-foreground/50"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="glass-panel rounded-2xl overflow-hidden">
        {isLoading && (
          <div className="p-12 text-center text-muted-foreground font-serif italic">Loading users...</div>
        )}
        
        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground font-serif italic">No users found.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {filtered.map(user => (
              <div key={user.id} className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center gap-5 flex-1 min-w-0">
                  {user.imageUrl ? (
                    <img src={user.imageUrl} className="w-12 h-12 rounded-xl object-cover border border-white/10 shrink-0 grayscale" alt="" />
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-white/[0.05] flex items-center justify-center text-white font-serif text-xl border border-white/10 shrink-0">
                      {(user.name || user.email || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 mb-1.5">
                      <h3 className="font-serif text-lg tracking-wide truncate">{user.name || "Unknown User"}</h3>
                      {user.status === "active" ? (
                        <span className="bg-white/10 text-foreground rounded-md px-2 py-0.5 text-[9px] uppercase tracking-widest border border-white/10">Active</span>
                      ) : (
                        <span className="bg-black/20 text-muted-foreground rounded-md px-2 py-0.5 text-[9px] uppercase tracking-widest border border-white/10">{user.status}</span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate opacity-80">{user.email}</div>
                  </div>
                </div>
                
                <div className="flex items-center gap-6 text-[10px] uppercase tracking-[0.15em] text-muted-foreground sm:ml-auto">
                  <div className="flex items-center gap-1.5">
                    <UsersIcon className="w-3.5 h-3.5 opacity-50" />
                    <span>{user.dealerCount} workspace{user.dealerCount === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 hidden sm:flex">
                    <Calendar className="w-3.5 h-3.5 opacity-50" />
                    <span>Joined {new Date(user.createdAt).toLocaleDateString()}</span>
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

