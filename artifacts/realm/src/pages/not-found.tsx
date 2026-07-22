import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background font-sans">
      <Card className="w-full max-w-md mx-4 bg-white border-border rounded-none shadow-none">
        <CardContent className="pt-8 pb-8 flex flex-col items-center text-center">
          <div className="w-12 h-12 mb-6 border border-border flex items-center justify-center bg-gray-50">
            <AlertCircle className="h-6 w-6 text-black" />
          </div>
          <h1 className="text-2xl font-serif text-black mb-3">404 Page Not Found</h1>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Did you forget to add the page to the router?
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
