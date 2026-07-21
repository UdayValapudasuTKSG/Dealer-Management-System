import { useLocation } from "wouter";
import { useCopilotReadable, useCopilotAction } from "@copilotkit/react-core";
import {
  useGetDashboardSummary,
  useListGates,
  getListGatesQueryKey,
} from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";

const ROUTE_MAP: Record<string, string> = {
  home: "/command-center",
  "command center": "/command-center",
  "daily briefing": "/command-center",
  "my day": "/command-center",
  dashboard: "/command-center",
  // journey is shelved from the nav for now
  // approvals live inline on the records they concern (lead/deal/finance)
  approvals: "/deals",
  gates: "/deals",
  inventory: "/inventory",
  showroom: "/inventory",
  pipeline: "/pipeline",
  leads: "/pipeline",
  deals: "/deals",
  finance: "/finance",
  service: "/service",
  workshop: "/service",
  "my jobs": "/service",
  deliveries: "/deliveries",
  delivery: "/deliveries",
  bookings: "/deliveries",
  handover: "/deliveries",
  customers: "/customers",
  gra: "/gra",
  "gra filing": "/gra",
  filing: "/gra",
};

const ROUTE_LABEL: Record<string, string> = {
  "/command-center": "My Day",
  "/inventory": "Inventory",
  "/pipeline": "Pipeline",
  "/leads": "Pipeline",
  "/deals": "Deals",
  "/finance": "Finance",
  "/service": "Service",
  "/deliveries": "Deliveries",
  "/customers": "Accounts",
  "/gra": "GRA Filing",
};

export function AuraCopilot() {
  const [location, navigate] = useLocation();
  const { can } = useAuthz();
  const { data: summary } = useGetDashboardSummary();
  // Roles without approvals access skip the gates query instead of 403ing.
  const { data: pendingGates } = useListGates(
    { status: "pending" },
    {
      query: {
        queryKey: getListGatesQueryKey({ status: "pending" }),
        enabled: can("approvals", "view"),
      },
    },
  );

  useCopilotReadable({
    description:
      "The page the dealership manager is currently viewing inside AURA.",
    value: ROUTE_LABEL[location] ?? location,
  });

  useCopilotReadable({
    description:
      "Live dealership KPIs from the AURA My Day home (dashboard summary).",
    value: summary ?? "loading",
  });

  useCopilotReadable({
    description:
      "Human decision gates currently awaiting a manager (the never-list). Each item is a decision only a human should make.",
    value:
      pendingGates?.map((g) => ({
        id: g.id,
        type: g.type,
        title: g.title,
        priority: g.priority,
        customer: g.customerName,
        amount: g.amount,
        summary: g.summary,
      })) ?? [],
  });

  useCopilotAction({
    name: "navigateTo",
    description:
      "Navigate the manager to a section of AURA. Use when they ask to go to, open, or show a page.",
    parameters: [
      {
        name: "destination",
        type: "string",
        description:
          "One of: my day, inventory, leads, deals, finance, service, customers, gra filing.",
        required: true,
      },
    ],
    handler: async ({ destination }) => {
      const key = destination.trim().toLowerCase();
      const path = ROUTE_MAP[key];
      if (!path) {
        return `I could not find a section called "${destination}".`;
      }
      navigate(path);
      return `Opened ${ROUTE_LABEL[path] ?? destination}.`;
    },
  });

  useCopilotAction({
    name: "openCustomer",
    description:
      "Open a specific customer's 360 profile by their numeric id.",
    parameters: [
      {
        name: "customerId",
        type: "number",
        description: "The numeric id of the customer to open.",
        required: true,
      },
    ],
    handler: async ({ customerId }) => {
      navigate(`/customers/${customerId}`);
      return `Opened customer #${customerId}.`;
    },
  });

  useCopilotAction({
    name: "startGraFiling",
    description:
      "Start a new Ghana Revenue Authority (GRA) vehicle import-duty filing. Use when the manager wants to file duty, clear a vehicle, or upload an import document.",
    parameters: [],
    handler: async () => {
      navigate("/gra");
      return "Opened the GRA filing workspace. Upload the import document to autofill the duty pack.";
    },
  });

  return null;
}
