export type WorldPoint = {
  x: number
  y: number
}

export const WORLD_WIDTH = 1000
export const WORLD_HEIGHT = 600

const MIN_LAT = 24
const MAX_LAT = 50
const MIN_LNG = -125
const MAX_LNG = -66

export function latLngToWorld(city: { lat: number; lng: number }): WorldPoint {
  const x =
    ((city.lng - MIN_LNG) / (MAX_LNG - MIN_LNG)) * WORLD_WIDTH

  const y =
    ((MAX_LAT - city.lat) / (MAX_LAT - MIN_LAT)) * WORLD_HEIGHT

  return { x, y }
}
