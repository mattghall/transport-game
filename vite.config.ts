import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  appType: "spa",
  plugins: [react()],
  server: {
    host: true,
    hmr: {
      overlay: false,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        compare: fileURLToPath(new URL("./compare.html", import.meta.url)),
        admin: fileURLToPath(new URL("./admin.html", import.meta.url)),
        training: fileURLToPath(new URL("./training.html", import.meta.url)),
        "manual-training": fileURLToPath(new URL("./manual-training.html", import.meta.url)),
        coach: fileURLToPath(new URL("./coach.html", import.meta.url)),
      },
    },
  },
})
