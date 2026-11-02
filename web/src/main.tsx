import { createRoot } from "react-dom/client";

import App from "./App";
import { captureAttribution } from "./lib/attribution";
import "./index.css";

captureAttribution();

createRoot(document.getElementById("root")!).render(<App />);
