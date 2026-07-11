import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/layout/shell";

import Landing from "@/pages/landing";
import Dashboard from "@/pages/dashboard";
import Inventory from "@/pages/inventory";
import Leads from "@/pages/leads";
import Deals from "@/pages/deals";
import Appraisals from "@/pages/appraisals";
import Finance from "@/pages/finance";
import Service from "@/pages/service";
import Customers from "@/pages/customers";
import CustomerDetail from "@/pages/customer-detail";
import Approvals from "@/pages/approvals";
import Journey from "@/pages/journey";
import Gra from "@/pages/gra";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

function AppShell() {
  return (
    <Shell>
      <Switch>
        <Route path="/pipeline" component={Leads} />
        <Route path="/leads" component={Leads} />
        <Route path="/command-center" component={Dashboard} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/deals" component={Deals} />
        <Route path="/appraisals" component={Appraisals} />
        <Route path="/finance" component={Finance} />
        <Route path="/service" component={Service} />
        <Route path="/approvals" component={Approvals} />
        <Route path="/customers" component={Customers} />
        <Route path="/customers/:id" component={CustomerDetail} />
        <Route path="/journey" component={Journey} />
        <Route path="/gra" component={Gra} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKit runtimeUrl={`${import.meta.env.BASE_URL}api/copilotkit`}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Switch>
              <Route path="/" component={Landing} />
              <Route>
                <AppShell />
              </Route>
            </Switch>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </CopilotKit>
    </QueryClientProvider>
  );
}

export default App;