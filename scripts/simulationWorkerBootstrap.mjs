import { tsImport } from "tsx/esm/api"

await tsImport("./simulationWorker.ts", {
  parentURL: import.meta.url,
})
