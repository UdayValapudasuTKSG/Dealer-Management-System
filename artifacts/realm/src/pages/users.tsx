import { useState } from "react";
import { useListPlatformUsers } from "@workspace/api-client-react";
import { Users as UsersIcon, Search, Activity, Calendar } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function Users() {
  const { data: users, isLoading } = useListPlatformUsers();
  const [search, setSearch] = useState("");

  const filtered = (users ?? []).filter(u => 
    (u.name || "").toLowerCase().includes(search.toLowerCase()) ||
    (u.email || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Platform Users</h1>
          <p className="text-muted-foreground mt-1">Identities managed across the network.</p>
        </div>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input 
          placeholder="Search by name or email..." 
          className="pl-9 bg-card/50 border-white/10 max-w-md"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-card/30 border border-white/5 rounded-2xl overflow-hidden">
        {isLoading && (
          <div className="p-12 text-center text-muted-foreground animate-pulse">Loading users...</div>
        )}
        
        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">No users found.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {filtered.map(user => (
              <div key={user.id} className="p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  {user.imageUrl ? (
                    <img src={user.imageUrl} className="w-12 h-12 rounded-xl object-cover border border-white/10 shrink-0" alt="" />
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary font-bold text-lg border border-primary/20 shrink-0">
                      {(user.name || user.email || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-white truncate">{user.name || "Unknown User"}</h3>
                      {user.status === "active" ? (
                        <Badge variant="outline" className="text-emerald-400 border-emerald-400/20 bg-emerald-400/10 text-[10px] px-1.5 py-0">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground border-white/10 bg-white/5 text-[10px] px-1.5 py-0">{user.status}</Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground truncate">{user.email}</div>
                  </div>
                </div>
                
                <div className="flex items-center gap-6 text-sm text-muted-foreground sm:ml-auto">
                  <div className="flex items-center gap-1.5">
                    <UsersIcon className="w-4 h-4 text-primary/70" />
                    <span>{user.dealerCount} workspace{user.dealerCount === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 hidden sm:flex">
                    <Calendar className="w-4 h-4 text-primary/70" />
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
