export type ConnectionCurve = {
  x?: number
  y?: number
}

export type LabelSide = "right" | "left" | "top" | "bottom"

export type AdjacentCity = {
  id: string
  distance: number
  allowRail?: boolean
  curve?: ConnectionCurve
}

export type City = {
  id: string
  name: string
  lat: number
  lng: number
  size: number
  population: number
  region?: string[]
  labelSide?: LabelSide
  adjacentCities?: AdjacentCity[]
}

export type GameMap = {
  id: string
  name: string
  width: number
  height: number

  cities: City[]
}
