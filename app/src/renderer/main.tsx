import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ui/tokens.css";
import "./style.css";
import "./select.css";
import "./ui/primitives.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
