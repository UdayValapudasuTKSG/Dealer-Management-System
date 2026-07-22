import { Button } from "@/components/ui/button";
import { ShieldX, ArrowLeft } from "lucide-react";

export default function AccessDenied() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full text-center space-y-8">
        <div className="w-16 h-16 bg-gray-100 text-black flex items-center justify-center mx-auto border border-border">
          <ShieldX className="w-8 h-8" />
        </div>
        
        <div className="space-y-4">
          <h1 className="text-4xl font-serif text-black">Access Denied</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            AURA Realm is restricted to platform operators and super administrators. Your account does not have the required clearance.
          </p>
        </div>

        <div className="pt-8 border-t border-border">
          <Button asChild className="w-full bg-white hover:bg-gray-50 text-black border border-border rounded-none uppercase tracking-widest text-xs" variant="outline">
            <a href="/">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Return to Dealership Platform
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
