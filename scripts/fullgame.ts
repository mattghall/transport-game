/**
 * Full 10-year game simulation — uses runBotSimulation and reports per-year stats
 */

import { runBotSimulation } from "../src/bots/simulate"
import { buildVictoryStandings } from "../src/engine/economy"

function fmt(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}
function fmtMoney(n: number) {
  if (Math.abs(n) >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M"
  if (Math.abs(n) >= 1_000) return "$" + (n / 1_000).toFixed(0) + "K"
  return "$" + n.toFixed(0)
}

const result = runBotSimulation({ seed: 42, maxSteps: 50_000, recordTrace: false })
const { game } = result

console.log("Transport Game — Full 10-Year Simulation")
console.log(`Mode: all-bots → ${game.operatingConfig.simulationTicksPerPeriod} quarterly ticks/year`)
console.log(`Steps: ${result.steps} | Timed out: ${result.timedOut} | Game over: ${game.isGameOver}`)
console.log("")

for (const player of game.players) {
  const hist = player.periodHistory ?? []
  console.log(`\n── ${player.name} (${player.botPreset ?? "default"}) ────────────────────────────────`)
  console.log("Year | Passengers   | Revenue     | Op Costs    | Net Rev     | Cash        | Bus / Rail / Air")
  console.log("-----|--------------|-------------|-------------|-------------|-------------|------------------")
  for (const h of hist) {
    const { bus = 0, rail = 0, air = 0 } = h.passengersServedByMode
    console.log(
      `  ${String(h.period).padEnd(3)} | ${fmt(h.passengersServed).padStart(12)} | ${fmtMoney(h.grossRevenue).padStart(11)} | ${fmtMoney(h.operatingCosts).padStart(11)} | ${fmtMoney(h.netRevenue).padStart(11)} | ${fmtMoney(h.endingCash).padStart(11)} | ${fmt(bus)} / ${fmt(rail)} / ${fmt(air)}`
    )
  }
  const totalPax = hist.reduce((s, h) => s + h.passengersServed, 0)
  console.log(`  --- TOTAL: ${fmt(totalPax)} passengers (lifetime: ${fmt(player.totalPassengersServed)})`)
}

const standings = buildVictoryStandings(game)
console.log("\n── FINAL STANDINGS ──────────────────────────────────────────")
standings.forEach((s, i) => {
  console.log(`  #${i + 1} ${s.player.name}: ${fmt(s.player.totalPassengersServed)} passengers | ${fmtMoney(s.player.money)} cash`)
})
