import type { WorldPoint } from "./projection"

export function distance(a: WorldPoint, b: WorldPoint): number {
  const dx = a.x - b.x
  const dy = a.y - b.y

  return Math.sqrt(dx * dx + dy * dy)
}