import React from "react";
import { createRoot } from "react-dom/client";
import SaveStatus from "../../src/ui/SaveStatus.jsx";

export function mount() {
  createRoot(document.body).render(<SaveStatus username="test" />);
}
