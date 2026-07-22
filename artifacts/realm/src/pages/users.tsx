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
    <div className="space-y-8 font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-3xl font-serif text-foreground">Platform Users</h1>
          <p className="text-sm text-muted-foreground mt-2 uppercase tracking-widest">Identities managed across the network</p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input 
          placeholder="Search by name or email..." 
          className="pl-9 bg-white border-border rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-black"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-white border border-border">
        {isLoading && (
          <div className="p-12 text-center text-muted-foreground font-serif italic">Loading users...</div>
        )}
        
        {!isLoading && filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground font-serif italic">No users found.</div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map(user => (
              <div key={user.id} className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-5 flex-1 min-w-0">
                  {user.imageUrl ? (
                    <img src={user.imageUrl} className="w-12 h-12 object-cover border border-border shrink-0" alt="" />
                  ) : (
                    <div className="w-12 h-12 bg-muted/30 flex items-center justify-center text-black font-serif text-xl border border-border shrink-0">
                      {(user.name || user.email || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 mb-1.5">
                      <h3 className="font-serif text-lg text-black truncate">{user.name || "Unknown User"}</h3>
                      {user.status === "active" ? (
                        <Badge variant="outline" className="border-black text-black rounded-none px-2 py-0.5 text-[10px] uppercase tracking-widest">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="border-border text-muted-foreground rounded-none px-2 py-0.5 text-[10px] uppercase tracking-widest">{user.status}</Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">{user.email}</div>
                  </div>
                </div>
                
                <div className="flex items-center gap-6 text-[10px] uppercase tracking-widest text-muted-foreground sm:ml-auto">
                  <div className="flex items-center gap-1.5">
                    <UsersIcon className="w-3.5 h-3.5 text-black" />
                    <span>{user.dealerCount} workspace{user.dealerCount === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 hidden sm:flex">
                    <Calendar className="w-3.5 h-3.5 text-black" />
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
