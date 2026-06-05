import { buildVictoryStandings } from "../src/engine/economy.ts"
import { runBotSimulation } from "../src/bots/simulate.ts"

const simulationCount = Number.parseInt(process.argv[2] ?? "1", 10)
const baseSeed = Number.parseInt(process.argv[3] ?? "1", 10)

for (let index = 0; index < simulationCount; index += 1) {
  const seed = baseSeed + index
  const result = runBotSimulation({ seed })
  const standings = buildVictoryStandings(result.game)

  console.log(
    JSON.stringify(
      {
        seed,
        steps: result.steps,
        winnerId: result.winnerId,
        standings: standings.map((standing, standingIndex) => ({
          rank: standingIndex + 1,
          playerId: standing.player.id,
          playerName: standing.player.name,
          passengers: standing.player.totalPassengersServed,
          connectedCities: standing.connectedCities,
          money: standing.player.money,
        })),
      },
      null,
      2,
    ),
  )
}
