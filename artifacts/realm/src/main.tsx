import { createRoot } from "react-dom/client";
import { setDealerHeaderEnabled } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Realm is dealer-agnostic: never send the x-dealer-id header a previous
// aura session may have left in localStorage — a stale/expired impersonation
// dealer id would otherwise 403 every platform request.
setDealerHeaderEnabled(false);

createRoot(document.getElementById("root")!).render(<App />);
