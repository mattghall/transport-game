export type City = {
  id: string
  name: string
  lat: number
  lng: number
  size: number
  population: number
  region?: string[]
}

export type GameMap = {
  id: string
  name: string
  width: number
  height: number

  cities: City[]
}
