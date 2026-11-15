import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
          if (/\/lucide-react\//.test(id)) return "icons";
          if (/\/(react-markdown|rehype-highlight|remark-gfm|highlight.js|lowlight|micromark|mdast|hast|unist)[/]/.test(id)) {
            return "markdown";
          }
        },
      },
    },
  },
});
