# Sharpe Sprint rebuild — cleanest paper bot

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rizalarkana77/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-rebuild/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rizalarkana77/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-rebuild/reward.svg)

Entry for make.fun's **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins**
([bounty page](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?ref=9f4fsyjb)).
Places go by hourly Sharpe ratio on a 6-hour forward pump.fun replay, so
this bot is built for a smooth equity curve rather than a lucky moonshot:
many small identical trades, quick exits, and a hard ceiling on how much
paper capital is ever at risk at once.

## How it trades

- **One fixed stake.** Every position is 0.05 SOL, capped by the
  harness's 1%-of-real-reserve order limit, spare cash, and a 0.30 SOL
  total-exposure ceiling. Uniform sizing keeps hourly returns even.
- **Entries need a live tape.** A curve must be at least 90 slots old,
  have traded within the last 20 slots, and show broad buying over the
  last 45 slots: at least 5 buys from at least 3 distinct buyers, at
  least 0.6 SOL of net inflow, and a price up 6–100% over the window
  while staying within 8% of the window high. Real reserves must sit
  between 1.2 and 60 SOL. At most 2 entries per mint, with a 150-slot
  wait after any exit.
- **Exits are mechanical.** Take profit at +20%; a trailing stop that
  arms once the peak passes +12% and sells 8% below that peak; a hard
  stop at −10%; a 450-slot time stop; a flow-fade exit when sellers
  take over the last 25 slots; and a dead-tape exit when a held curve
  has not traded for 120 slots. Sells use 100% slippage tolerance so
  exits always fill.
- **Guardrail pacing.** The minimum bar is a round trip of at least
  0.01 SOL on at least 20 distinct mints. The bot tracks filled buys
  and, if the tally lags the schedule (22 coins by slot 36,000), spends
  a 0.011 SOL probe on the deepest uncounted live curve and sells it
  straight back.

## Determinism

The harness runs the entry twice and requires byte-identical action
logs. Every decision here is a pure function of the input stream: no
wall clock, no randomness, and all price comparisons are exact BigInt
cross-multiplications of the virtual reserves — no floats anywhere near
a trading decision.

## Run it

Node 22, standard library only, no network:

```
node main.ts
```

It speaks the `agent-fun/replay/v2` JSON-lines protocol on stdin/stdout:
`hello` and `batch` messages in, one `reply` per batch out.

## Paper only

This bot trades paper money on recorded market data. It holds no keys,
signs nothing, and moves no funds.

Built for make.fun — https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?ref=9f4fsyjb
