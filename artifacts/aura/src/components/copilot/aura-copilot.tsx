import { useLocation } from "wouter";
import { useCopilotReadable, useCopilotAction } from "@copilotkit/react-core";
import { useGetDashboardSummary, useListGates } from "@workspace/api-client-react";

const ROUTE_MAP: Record<string, string> = {
  home: "/pipeline",
  "command center": "/command-center",
  dashboard: "/command-center",
  journey: "/journey",
  approvals: "/approvals",
  gates: "/approvals",
  inventory: "/inventory",
  showroom: "/inventory",
  pipeline: "/pipeline",
  leads: "/pipeline",
  deals: "/deals",
  appraisals: "/appraisals",
  finance: "/finance",
  service: "/service",
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
  "/command-center": "Command Center",
  "/journey": "Journey",
  "/approvals": "Approvals",
  "/inventory": "Inventory",
  "/pipeline": "Pipeline",
  "/leads": "Pipeline",
  "/deals": "Deals",
  "/appraisals": "Appraisals",
  "/finance": "Finance",
  "/service": "Service",
  "/deliveries": "Deliveries",
  "/customers": "Customers",
  "/gra": "GRA Filing",
};

export function AuraCopilot() {
  const [location, navigate] = useLocation();
  const { data: summary } = useGetDashboardSummary();
  const { data: pendingGates } = useListGates({ status: "pending" });

  useCopilotReadable({
    description:
      "The page the dealership manager is currently viewing inside AURA.",
    value: ROUTE_LABEL[location] ?? location,
  });

  useCopilotReadable({
    description:
      "Live dealership KPIs from the AURA command center (dashboard summary).",
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
          "One of: command center, journey, approvals, inventory, leads, deals, appraisals, finance, service, customers, gra filing.",
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
