export type DebugLogEntry = {
  category: string
  message: string
  data?: Record<string, unknown>
}

let debugEnabled = false
const entries: DebugLogEntry[] = []

export function enableDebugMode() {
  debugEnabled = true
  entries.length = 0
}

export function disableDebugMode() {
  debugEnabled = false
}

export function isDebugEnabled() {
  return debugEnabled
}

export function debugLog(category: string, message: string, data?: Record<string, unknown>) {
  if (!debugEnabled) return
  entries.push({ category, message, data })
}

export function getDebugEntries(): ReadonlyArray<DebugLogEntry> {
  return entries
}

export function clearDebugLog() {
  entries.length = 0
}
