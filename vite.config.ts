import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url))
const PUBLIC_TRAINING_DIR = resolve(PROJECT_ROOT, "public/training-results")

function writeTrainingResultsFile(relativePath: string, body: string) {
  const normalizedPath = decodeURIComponent(relativePath).replace(/^\/+/, "")
  if (!normalizedPath) {
    throw new Error("Training results path is required.")
  }

  const destinationPath = resolve(PUBLIC_TRAINING_DIR, normalizedPath)
  const publicTrainingPrefix = `${PUBLIC_TRAINING_DIR}/`
  if (destinationPath !== PUBLIC_TRAINING_DIR && !destinationPath.startsWith(publicTrainingPrefix)) {
    throw new Error("Training results path must stay inside public/training-results.")
  }

  mkdirSync(dirname(destinationPath), { recursive: true })
  writeFileSync(destinationPath, body, "utf8")
}

export default defineConfig({
  appType: "spa",
  plugins: [
    react(),
    {
      name: "training-results-write-api",
      configureServer(server) {
        server.middlewares.use("/api/training-results", (request, response, next) => {
          if (request.method !== "PUT") {
            next()
            return
          }

          const relativePath = request.url ?? ""
          const chunks: Buffer[] = []
          request.on("data", chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          })
          request.on("end", () => {
            try {
              writeTrainingResultsFile(relativePath, Buffer.concat(chunks).toString("utf8"))
              response.statusCode = 200
              response.setHeader("Content-Type", "application/json; charset=utf-8")
              response.end(JSON.stringify({ ok: true }))
            } catch (error) {
              response.statusCode = 400
              response.setHeader("Content-Type", "application/json; charset=utf-8")
              response.end(JSON.stringify({
                error: error instanceof Error ? error.message : "Could not write training results file.",
              }))
            }
          })
          request.on("error", () => {
            response.statusCode = 500
            response.setHeader("Content-Type", "application/json; charset=utf-8")
            response.end(JSON.stringify({ error: "Could not read training results request body." }))
          })
        })
      },
    },
  ],
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
