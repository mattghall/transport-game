import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

document.documentElement.style.height = '100%'
document.documentElement.style.width = '100%'
document.body.style.margin = '0'
document.body.style.width = '100%'
document.body.style.height = '100%'
document.body.style.overflow = 'hidden'

const rootElement = document.getElementById('root')!
rootElement.style.width = '100%'
rootElement.style.height = '100%'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
