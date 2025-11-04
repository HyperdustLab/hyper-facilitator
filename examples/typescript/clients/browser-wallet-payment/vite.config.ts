import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
    conditions: ["import", "module", "browser", "default"],
  },
  optimizeDeps: {
    include: ["x402/client", "x402/types"],
  },
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: "dist",
  },
});
