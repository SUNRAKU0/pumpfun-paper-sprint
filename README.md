# Pump.fun Paper Sprint — Momentum Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/SUNRAKU0/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/SUNRAKU0/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for pump.fun, built by an AI agent for
[make.fun's Pump.fun Paper Sprint bounty](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
Paper trading only — no real money, no entry fee. The 10 SOL capital is
virtual play money the replay gives the bot.

## Strategy

Buy a new coin once its price has already started running up, then get out
quickly on a profit target, a stop-loss, or age. Pump.fun bonding curves
mostly dump after their first spike, so holding is a losing game; the edge,
if any, is riding the first minutes of a move and leaving before the crowd.

- **Buy:** coin seen, ≥ 5 trades, price up ≥ 5% from first-seen, the last
  10 trades all buys (live buy pressure, not a stale print), size cap
  ≥ 0.05 SOL, a position slot free, cash free. Exactly 0.05 SOL per buy,
  one buy per coin, max 5 open positions, bought only within 1200 slots
  of the coin's creation.
- **Sell (full position):** up ≥ 8% from entry, or down ≥ 3%, or held
  longer than 300 slots. Tight slippage guards (200 / 100 bps) so a fill
  two slots later never lands at a bad price.
- **Determinism:** no clock, no environment, no `Math.random`. Price
  comparisons are BigInt cross-multiplications, never floats, so the two
  grading runs produce byte-identical action logs.

## Layout

- `main.ts` — thin wrapper: hands the strategy to the harness shim.
- `strategy.ts` — the momentum strategy (fresh code, written for this bounty).
- `vendor/makefun-bot.ts` — the house SDK shim, copied byte-identical from
  the kit (`sdk/ts/makefun-bot.ts`) as its header instructs.

## Run

The grader runs the bot as `node /bot/main.ts` (Node 22+, no build, no install).

## Backtest

Backtested offline on the kit's dev dataset with the kit's own replay port
(`baselines/pilot/momentum/tools/sim.ts`, kept outside this repo).
Final defaults on that window: net PnL -0.1746 SOL, 228 fills, 114 distinct
mints, max drawdown 2.17% — guardrails met (≥ 20 mints, drawdown ≤ 50%),
two runs byte-identical. The dev window is one small sample and the final
window is fresh 6-hour data collected after the deadline, so the dev number
is a guardrail check, not a forecast; parameters were swept across ~50
combinations (momentum, dip-buying, buy-and-hold, slippage, stake size) and
the shipped set is the least-lossy robust one, not fitted to a single coin.

Referral code: `h4qpnq0g` — https://make.fun/r/h4qpnq0g
