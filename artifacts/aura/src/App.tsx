import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/layout/shell";

import Dashboard from "@/pages/dashboard";
import Inventory from "@/pages/inventory";
import Leads from "@/pages/leads";
import Deals from "@/pages/deals";
import Appraisals from "@/pages/appraisals";
import Finance from "@/pages/finance";
import Service from "@/pages/service";
import Customers from "@/pages/customers";
import Journey from "@/pages/journey";
import Assistant from "@/pages/assistant";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/leads" component={Leads} />
        <Route path="/deals" component={Deals} />
        <Route path="/appraisals" component={Appraisals} />
        <Route path="/finance" component={Finance} />
        <Route path="/service" component={Service} />
        <Route path="/customers" component={Customers} />
        <Route path="/journey" component={Journey} />
        <Route path="/assistant" component={Assistant} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;