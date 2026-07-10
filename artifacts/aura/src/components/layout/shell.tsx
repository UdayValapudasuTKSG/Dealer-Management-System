import { Sidebar } from "./sidebar";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative selection:bg-primary/20 selection:text-primary">
      {/* Ambient background glow */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      
      <Sidebar />
      
      <main className="flex-1 overflow-y-auto relative z-10 scroll-smooth">
        <div className="min-h-full">
          {children}
        </div>
      </main>
    </div>
  );
}