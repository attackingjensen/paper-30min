import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: false },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
