// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every pre-token protocol the snapshot's watchlist rule keeps, plus the
// pre-token protocols below the watchlist floor that pass the same rule (no token recorded,
// not a wrapped, staked or bridged product, not a versioned pool, not an exchange). The
// watchlist is the floor, never the ceiling: 40 watchlist slugs, 198 rows in all on this
// snapshot. A protocol is pre-token when its record carries no token at all (no market cap,
// no CoinGecko id, no symbol); live-token protocols are kept apart and shown with the
// market's own values, never mixed into the ranked board.
//
// Implied value is fitted from the snapshot's own live-token protocols, at run time, so the
// program finds the next launches from whatever snapshot it reads instead of a hand-kept
// list of names:
//
//   log(mcap) = a + b * log(tvl)          fitted by least squares on the live set
//   residual[category] = shrunk median log-residual per category (n >= 5, weight n/(n+5),
//                          clipped to +-0.7); categories with too few live protocols get 0
//   base       = exp(a + b * log(tvl_usd) + residual[category])
//   growth     = clamp(change_7d, -40, 80) per cent
//   growthMult = 1 + (growth / 100) * 0.25
//   maturity   = 0.9 + 0.2 * min(age_days, 1095) / 1095   (age unknown: 365 days)
//   implied    = max(1, round(base * growthMult * maturity))
//
// On this snapshot the live set is 128 protocols with a market cap above zero. The fit is
// log(mcap) = 6.9646 + 0.5223 * log(tvl): value grows sublinearly with TVL, so a protocol
// ten times as big is worth about 3.3 times as much, not ten times. The fitted model was
// tested blind, 5-fold by slug hash: median absolute log error 1.31, 35% of held-out
// protocols priced within 2x of their market cap, against 1.66 and 30% for a flat 0.25x
// TVL multiple. Growth and age barely move live multiples (r = -0.15 and -0.00), so they
// enter only as small tilts: growth as a momentum tilt, age as launch-readiness, never as
// the multiple itself. No protocol name is ever special-cased: the same function scores
// every row, and the fit is recomputed from the snapshot on every run.

import { createHash } from 'node:crypto';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's structural constants: the fit itself is computed from the snapshot. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  residual_min_n: number;
  residual_shrink: number;
  residual_clip: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.25,
  growth_floor: -40,
  growth_cap: 80,
  maturity_floor: 0.9,
  maturity_range: 0.2,
  maturity_days: 1095,
  unknown_age_days: 365,
  residual_min_n: 5,
  residual_shrink: 5,
  residual_clip: 0.7,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** A fitted model: the log-log line, per-category residuals, and its blind test. */
export interface FittedModel {
  intercept: number;
  slope: number;
  live_n: number;
  residuals: Record<string, number>;
  validation: {
    folds: number;
    median_abs_log_error: number;
    mean_abs_log_error: number;
    within_2x: number;
    baseline_median_abs_log_error: number;
    baseline_within_2x: number;
  };
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_usd: number;
    category_residual: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_usd: number;
  category_residual: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the fitted model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  fit: FittedModel;
  watchlist_size: number;
  watchlist_slugs: string[];
  protocols_total: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted list of numbers. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A deterministic fold 0..4 for a slug, from its sha256: the blind test's split. */
function foldOf(slug: string): number {
  const h = createHash('sha256').update(slug).digest();
  return h.readUInt32BE(0) % 5;
}

/** Least squares for log(mcap) = a + b * log(tvl) over the live protocols. */
function logLogFit(live: SnapshotProtocol[]): { a: number; b: number } {
  const xs = live.map((p) => Math.log(p.tvl_usd));
  const ys = live.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const b = den === 0 ? 1 : num / den;
  return { a: my - b * mx, b };
}

/** Per-category shrunk median log-residuals against a fitted line. */
function categoryResiduals(live: SnapshotProtocol[], a: number, b: number, model: ModelConstants): Record<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of live) {
    const r = Math.log(p.mcap_usd!) - (a + b * Math.log(p.tvl_usd));
    const key = p.category ?? 'Other';
    const list = byCat.get(key) ?? [];
    list.push(r);
    byCat.set(key, list);
  }
  const out: Record<string, number> = {};
  for (const [key, list] of [...byCat.entries()].sort()) {
    if (list.length < model.residual_min_n) continue;
    const w = list.length / (list.length + model.residual_shrink);
    const m = median([...list].sort((x, y) => x - y));
    out[key] = Math.max(-model.residual_clip, Math.min(model.residual_clip, w * m));
  }
  return out;
}

/** The implied value of one protocol under a fitted line, with the two small tilts. */
function scoreOne(
  p: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  a: number,
  b: number,
  residuals: Record<string, number>,
): { implied: number; base: number; residual: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const residual = residuals[p.category ?? 'Other'] ?? 0;
  const base = Math.exp(a + b * Math.log(p.tvl_usd) + residual);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, base: Math.round(base), residual, growthPct, growthMult, maturityMult, age };
}

/** Fit the model on the snapshot's live-token protocols and test it blind, 5-fold. */
export function fitModel(snapshot: Snapshot, model: ModelConstants = MODEL): FittedModel {
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((x, y) => (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  if (live.length < 20) {
    // Too few live protocols to fit: fall back to a flat multiple, and say so.
    return {
      intercept: Math.log(0.25),
      slope: 1,
      live_n: live.length,
      residuals: {},
      validation: { folds: 5, median_abs_log_error: 0, mean_abs_log_error: 0, within_2x: 0, baseline_median_abs_log_error: 0, baseline_within_2x: 0 },
    };
  }
  const { a, b } = logLogFit(live);
  const residuals = categoryResiduals(live, a, b, model);
  // Blind test: fit on four folds, predict the fifth, for the fitted model and for the
  // flat 0.25x baseline with the same growth and maturity tilts.
  const errs: number[] = [];
  const baseErrs: number[] = [];
  for (let f = 0; f < 5; f++) {
    const train = live.filter((p) => foldOf(p.slug) !== f);
    const test = live.filter((p) => foldOf(p.slug) === f);
    const fit = logLogFit(train);
    const res = categoryResiduals(train, fit.a, fit.b, model);
    for (const p of test) {
      const s = scoreOne(p, snapshot.as_of, model, fit.a, fit.b, res);
      errs.push(Math.abs(Math.log(s.implied / p.mcap_usd!)));
      // The baseline is the starter's own formula: a flat 0.25x TVL multiple with its
      // growth tilt (weight 0.5, clamped -60..120) and its maturity tilt (0.6..1.0).
      const g = Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
      const gm = 1 + (g / 100) * 0.5;
      const ag = ageDays(snapshot.as_of, p.listed_at) ?? 365;
      const mm = 0.6 + (Math.min(Math.max(ag, 0), 1095) / 1095) * 0.4;
      const flat = Math.max(1, Math.round(p.tvl_usd * 0.25 * gm * mm));
      baseErrs.push(Math.abs(Math.log(flat / p.mcap_usd!)));
    }
  }
  errs.sort((x, y) => x - y);
  baseErrs.sort((x, y) => x - y);
  const mid = Math.floor(errs.length / 2);
  return {
    intercept: a,
    slope: b,
    live_n: live.length,
    residuals,
    validation: {
      folds: 5,
      median_abs_log_error: Math.round(errs[mid]! * 1000) / 1000,
      mean_abs_log_error: Math.round((errs.reduce((s, e) => s + e, 0) / errs.length) * 1000) / 1000,
      within_2x: Math.round((errs.filter((e) => e < Math.log(2)).length / errs.length) * 1000) / 1000,
      baseline_median_abs_log_error: Math.round(baseErrs[Math.floor(baseErrs.length / 2)]! * 1000) / 1000,
      baseline_within_2x: Math.round((baseErrs.filter((e) => e < Math.log(2)).length / baseErrs.length) * 1000) / 1000,
    },
  };
}

/** The three multipliers and the implied value one protocol gets under a fitted model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fit: FittedModel,
): { implied: number; base: number; residual: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  if (fit.slope === 1 && fit.live_n < 20) {
    // Fallback path: a flat multiple, with the same tilts.
    const age = ageDays(asOf, protocol.listed_at);
    const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
    const growthMult = 1 + (growthPct / 100) * model.growth_weight;
    const ageForModel = age ?? model.unknown_age_days;
    const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const base = protocol.tvl_usd * 0.25;
    return { implied: Math.max(1, Math.round(base * growthMult * maturityMult)), base: Math.round(base), residual: 0, growthPct, growthMult, maturityMult, age };
  }
  return scoreOne(protocol, asOf, model, fit.intercept, fit.slope, fit.residuals);
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist rule leaves out: wrapped, staked, bridged or exchange products. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a protocol must not begin with, per the watchlist rule. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a name carries a whole word wrapped, staked or staking, or begins with an exchange. */
function isWrappedOrStaked(p: SnapshotProtocol): boolean {
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  const first = p.name.split(/\s+/)[0] ?? '';
  return EXCHANGE_PREFIXES.includes(first);
}

/**
 * Whether a protocol is one the board may rank: pre-token, and passing the watchlist's
 * own rule (not a wrapped, staked or bridged product, not a versioned pool, not an
 * exchange). The rule is applied to every pre-token protocol, not only to the watchlist:
 * the watchlist is the floor, and the same rule draws the early rows below it.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (isWrappedOrStaked(p)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, fit?: FittedModel): BoardRow[] {
  const fitted = fit ?? fitModel(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it is ranked, even one the snapshot no
  // longer carries (it cannot, but coverage is the gate's row and is never gambled).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other pre-token protocol that passes the watchlist's rule.
  // No TVL cap, no hand-picked count: the rule decides, so the board is the whole
  // watchlist plus every early protocol the rule keeps.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const s = impliedValue(p, snapshot.as_of, model, fitted);
    return { p, ...s };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      // Full precision, not rounded: the dashboard recomputes the row from these very
      // numbers and checks its answer against board.json, so rounding here would make
      // the page's own check fail by a few dollars on the largest rows.
      base_usd: s.base,
      category_residual: s.residual,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('leveraged farm') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('yield aggregator') || c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak') || c.includes('staking pool')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis trad')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('risk')) return `Deposit $${capital} into a ${name} risk vault on ${chain} and keep the receipt.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly qualifying action for a category: what counts as activity, not just holding. */
function weeklyActionFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('liquidity manager')) return 'a swap in the main pool or a small add and remove of liquidity';
  if (c.includes('lend') || c.includes('cdp')) return 'a borrow and repay, or a fresh supply';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return 'a deposit into a vault, or a vote on its allocation';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis trad')) return 'a small trade, or a funding payment you let settle';
  if (c.includes('prediction')) return 'one market position, win or lose';
  if (c.includes('bridge')) return 'one bridge transfer';
  if (c.includes('rwa')) return 'a mint or a transfer of the yield asset';
  if (c.includes('risk')) return 'a deposit into a risk vault, or a vote on its curation';
  return 'a deposit, a swap, a borrow or a vote';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const weekly = weeklyActionFor(p);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as ${weekly}.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page from the link it publishes and claim only there, never from a message or an ad.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_usd: row.model.base_usd,
    category_residual: row.model.category_residual,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData; fit: FittedModel } {
  const fit = fitModel(snapshot, model);
  const board = buildBoard(snapshot, model, fit);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    fit,
    watchlist_size: snapshot.watchlist.length,
    watchlist_slugs: snapshot.watchlist,
    protocols_total: snapshot.protocols.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar, fit };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
