# Token Launch Radar

[![make.fun](https://make.fun/badge/wdya123/token-radar)](https://make.fun/c/token-radar-01)
[![make.fun score](https://make.fun/badge/wdya123/token-radar/score)](https://make.fun/c/token-radar-01)

> Badges above use the repository owner `wdya123`.

Every pre-token protocol DefiLlama tracks, ranked by what its launch would be worth —
with a concrete farm plan for each one.

## What it is

`main.ts` reads a sealed DefiLlama snapshot (758 protocols in the shipped one, as of
2026-11-14), keeps every protocol that records no token at all and passes the
watchlist's own rule (not a wrapped, staked or bridged product, not a versioned pool,
not an exchange), and ranks them by implied launch value. The board is 198 rows: the
40 watchlist protocols plus 158 early protocols below the $50M TVL floor. The 24
largest live-token protocols sit apart as the market reference.

## The value model (radar-2)

The implied value is fitted from the snapshot's own live-token protocols, at run time:

```
log(mcap) = a + b * log(tvl)        fitted by least squares on the live set
base      = exp(a + b * log(tvl) + category residual)
implied   = base × growth tilt × maturity tilt
```

- The fit on this snapshot is `log(mcap) = 6.9646 + 0.5223 * log(tvl)` over 128
  live-token protocols with a market cap above zero: value grows sublinearly with TVL.
- Category residual: the shrunk median log-residual per category (n ≥ 5, weight n/(n+5),
  clipped to ±0.7). Categories with too few live protocols get 0.
- Growth tilt: `1 + clamp(change_7d, −40%, +80%) × 0.25`.
- Maturity tilt: `0.90–1.10` by age (unknown age counts as 365 days).
- Blind test, 5-fold split by slug hash: median absolute log error 1.31, 35% of held-out
  protocols within 2x of their market cap, against 1.66 and 30% for a flat 0.25x TVL
  multiple. Growth and age barely move live multiples (r = −0.15 and −0.00), so they
  enter only as small tilts.

No protocol name is ever special-cased. The same function scores every row, and the
fit is recomputed from whatever snapshot the program reads, so the radar finds the
next launches early instead of from a hand-kept list.

## The farm plan

Each row carries six steps derived from its own record (category, chains, TVL, age):
a fresh wallet, the category's qualifying action with concrete capital ($50–$250 by
TVL), one qualifying action a week, a hold of 30–60 days, claiming only from the
protocol's own page, and a farm log. Every step carries a cost and a time.

## The dashboard

`dashboard/` is a static page (no network, no framework): a sortable and filterable
board, a live-token reference tab, a detail view for every protocol that recomputes
the row's implied value and farm plan in the page and checks both against
`board.json`, and a model panel that states the formula, the fitted constants, the
category adjustments and the blind-test numbers.

## Run it

```bash
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The command writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` to the output directory. It fetches nothing and takes no clock, no
random number and no locale into its output: two runs over the same snapshot produce
byte-identical files.

Requires Node.js 22.18 or later. No other dependency.

## Files

- `main.ts` — the entry point: snapshot in, board and dashboard out.
- `lib/model.ts` — the model, the watchlist rule, the farm plans, the board.
- `vendor/makefun-board.ts` — the kit's dossier builder, copied byte for byte.
- `dashboard/` — the static dashboard (`index.html`, `app.css`, `app.js`).
- `screenshots/` — the three screenshots, rendered from this dashboard in headless
  Google Chrome 157 (1440×900 board, 1440×1080 detail, 1440×900 filtered view):
  the board table, a protocol detail with its recomputed value and farm plan, and
  the board filtered to the Dexs category.
- `LICENSE` — MIT.

## Status

Built locally, not yet submitted. Before submission the repository needs a GitHub
owner (badges above), a Solana keypair linked to a make.fun account, the three
screenshots re-rendered from this dashboard, and a transcript bundle for the
sessions that built it.
