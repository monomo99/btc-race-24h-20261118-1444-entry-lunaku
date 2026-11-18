# BTC Race — Dip Buyer

A low-frequency dip-buying bot for the 24h BTC race.

**Strategy:** buy a symbol when its close falls 2% below its 240-bar rolling
high (a full window of history required), take profit at +2% from entry, and
trail the stop 1% under the highest close since entry. After a stop-out the
symbol sits out for 120 bars. One buy per symbol per batch, spending at most
half the cash on hand and never more than the weight room; sells never fund
buys in the same reply.

**Why it works:** the race rewards catching mean-reversion after sharp
pullbacks while cutting losers fast. The 240-bar high keeps entries tied to
the recent trend (no buying into a free-fall with no history), the +2% target
locks in the bounce, and the 1% trailing stop exits before a dip turns into
a trend. The 120-bar cooldown stops the bot from re-buying the same falling
knife it just got stopped out of.

**Files:** `main.ts` (the bot), `vendor/makefun-bars.ts` (the kit's bars shim,
copied byte-for-byte).
