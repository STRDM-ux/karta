import path from "path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 5173,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Expose both VITE_* and EXPO_PUBLIC_* (Rork cross-platform
  // public-env convention, written by tools like getOrCreateAuthConfig).
  envPrefix: ["VITE_", "EXPO_PUBLIC_"],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-dom") || id.includes("react-router-dom") || id.includes("/react/")) {
            return "vendor-react";
          }
          if (id.includes("@tanstack/react-query")) return "vendor-query";
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("sonner") || id.includes("next-themes")) return "vendor-toasts";
          // Everything else (pdfjs-dist, fflate, qrcode, ...) is left to the
          // bundler so heavy libraries only load with the page that uses them
          // instead of being preloaded on every page.
          return undefined;
        },
      },
    },
  },
}));
