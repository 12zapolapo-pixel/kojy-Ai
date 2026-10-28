/**
 * Web App Entry Point
 * OWNERSHIP: apps/web/src
 */

import { StrictMode }  from "react";
import { createRoot }  from "react-dom/client";
import App             from "./app/App";
import { initializeAuth } from "./state/authStore";
import "./styles/globals.css";

// Initialize auth session before React renders
// (synchronous store setup — async validation happens inside initialize())
initializeAuth();

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
