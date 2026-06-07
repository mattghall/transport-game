import React from "react"
import ReactDOM from "react-dom/client"
import ManualTrainingApp from "./ManualTrainingApp"

document.documentElement.style.height = "100%"
document.documentElement.style.width = "100%"
document.body.style.margin = "0"
document.body.style.width = "100%"
document.body.style.minHeight = "100%"

const rootElement = document.getElementById("root")!
rootElement.style.width = "100%"
rootElement.style.minHeight = "100%"

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ManualTrainingApp />
  </React.StrictMode>,
)
