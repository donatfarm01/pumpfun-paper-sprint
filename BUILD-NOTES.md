# Build notes — Floor Sniper (pump.fun paper sprint)

## What this is

A single program, main.ts, that paper-trades pump.fun coins on the
agent-fun replay harness. It is entered in the make.fun bounty "Pump.fun
Paper Sprint: Any Bot Can Win". The vendored file vendor/makefun-bot.ts is
the kit's own wire shim, copied unchanged; all strategy logic lives in
main.ts.

## The idea

The dev dataset showed one robust pattern: a new coin spikes in its first
few trades and then fades back to its creation price, and the price almost
never goes below that creation price. So the creation price is a floor.
Chasing the spike loses money, because the two-slot fill latency means the
buy lands after the run, and the fade then eats the entry. Three earlier
backtest variants proved this the expensive way: a momentum bot lost 9.6
SOL, a sniper lost 3.1 SOL, and a volume-filtered sniper lost 4.4 SOL, all
on the same 24 hour dev window with 10 SOL of paper capital.

The winning shape is therefore the opposite of chasing: only buy a coin
while it is still sitting at its floor, in its first few trades, and let
the winners run. The bot sells half at 40 percent above its average entry
price, trails the rest with a 25 percent pullback stop, cuts at 20 percent
below entry, and frees the slot after 3600 slots if nothing happened. It
trades many coins in small sizes, so no single coin can hurt it.

## The rules, in plain words

Entry: a coin in its first 16 trades, priced at most 10 percent above its
creation price and never below it, with at least 1 SOL of real reserve, so
the harness's 1 percent per-reply size cap can fund a buy of at least 0.01
SOL. Target size is 0.2 SOL per coin, topped up only while the coin is
still within its first 20 trades and still at its floor. At most 5 open
positions, at most 16 orders per batch, 5 percent slippage budget so a fill
that ran away from the decision price is rejected instead of chased.

Exits: sell half at plus 40 percent, then a trailing stop at 25 percent
below the peak seen since entry; a hard stop at minus 20 percent; a
timeout sell after 3600 slots. One exit per coin per batch.

Determinism: no clock, no environment reads, no randomness, and every
decision iterates over sorted mint lists. The two grading runs must produce
byte-identical action logs, and this bot is built to satisfy that.

## How it was validated

A Python mirror of the engine (same fill latency, same curve maths, same
size and position caps, same completion and flatten closes) backtested the
strategy on the kit's 24 hour dev window: net about minus 0.15 SOL, maximum
drawdown about 2 percent, about 136 round trips across about 134 distinct
coins, and every 6 hour block clearing the 20-coin minimum bar with margin
(the quietest block had 23 entries). The dev window is roughly breakeven;
the final 6 hour window is a fresh draw, and the value is the right tail:
the trailing stop keeps the coins that run to several multiples, while the
floor bounds the losers. A local grade with the kit's own grader is the
final check before submission.

## What did not work

Momentum entry after a 25 percent rise, volume-filtered sniping, dip-buying
faded coins, pyramiding into rising coins, and accumulating quiet coins all
tested worse on the same window. Tight stops bled money because the normal
fade to the floor triggers them. Widening the entry cap above 10 percent
above the floor bought more coins but lost more per coin, and at 40 percent
above the floor the drawdown approached the 50 percent guardrail. The
chosen settings are the plainest ones that stayed near breakeven with a
tiny drawdown and a safe margin above the minimum bar.
