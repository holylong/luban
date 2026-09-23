import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// The bundle is emitted into dist/web-ui, a sibling of the TypeScript outDir.
// They must stay separate: tsc emits dist/web/server.js for src/web/server.ts,
// so writing the SPA into dist/web would collide with the compiled server.
//
// Deliberately no React plugin: Vite's built-in esbuild transform already
// compiles TSX with the automatic JSX runtime, and every extra build plugin is
// another peer-dependency edge that can break `npm install`. The cost is that
// editing a component under `npm run dev:web` reloads the page instead of
// preserving component state through Fast Refresh.
export default defineConfig({
  root: resolve(root, "src/web/client"),
  base: "./",
  esbuild: { jsx: "automatic" },
  build: {
    outDir: resolve(root, "dist/web-ui"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:8642",
    },
  },
});
