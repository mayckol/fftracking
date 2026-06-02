import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build stamp shown in the titlebar so a running app can be matched to a build.
const BUILD_ID = new Date().toISOString().slice(0, 19).replace("T", " ");

// Tauri expects a fixed dev port and emits into ../dist (see tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2021", sourcemap: false },
});
