import { Button } from "@/components/ui/button";
import { ShieldX, ArrowLeft } from "lucide-react";

export default function AccessDenied() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 bg-destructive/20 text-destructive rounded-2xl flex items-center justify-center mx-auto">
          <ShieldX className="w-8 h-8" />
        </div>
        
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-white">Access Denied</h1>
          <p className="text-muted-foreground">
            AURA Realm is restricted to platform operators and super administrators. Your account does not have the required clearance.
          </p>
        </div>

        <div className="pt-6">
          <Button asChild className="w-full bg-white/5 hover:bg-white/10 text-white" variant="outline">
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
