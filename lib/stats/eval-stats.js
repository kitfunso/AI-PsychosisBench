/** Statistics and cost accounting for the token-efficiency evals: cost is priced over four buckets (uncached input, cache write, cache read, output).
*  Uncertainty uses paired, cluster (same-repository tasks are not independent) and paired-ratio bootstraps; every resampler takes a seed. */
const DEFAULT_ITERATIONS = 5000;
const DEFAULT_TWO_LEVEL_ITERATIONS = 10_000;
const DEFAULT_ALPHA = 0.05;
/** Sum several usages bucket by bucket. */
export function addUsage(...usages) {
  const total = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  for (const u of usages) {
    total.inputTokens += u.inputTokens;
    total.cacheWriteTokens += u.cacheWriteTokens;
    total.cacheReadTokens += u.cacheReadTokens;
    total.outputTokens += u.outputTokens;
  }
  return total;
}
/** Dollar cost of `usage` at `prices`. */
export function priceUsage(usage, prices) {
  return (usage.inputTokens * prices.inputPerMTok
    + usage.cacheWriteTokens * prices.cacheWritePerMTok
    + usage.cacheReadTokens * prices.cacheReadPerMTok
    + usage.outputTokens * prices.outputPerMTok) / 1_000_000;
}
/** Default cache price ratios (write 1.25x, read 0.1x of base input). */
export const DEFAULT_CACHE_RATIOS = { write: 1.25, read: 0.1 };
/** Input cost of `usage` in uncached-equivalent tokens (output excluded). */
export function uncachedEquivalentInput(usage, ratios = DEFAULT_CACHE_RATIOS) {
  return usage.inputTokens + usage.cacheWriteTokens * ratios.write + usage.cacheReadTokens * ratios.read;
}
/** Mulberry32: a small seeded PRNG returning floats in [0, 1). Same seed,
*  same stream, on every platform. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function percentileInterval(samples, alpha) {
  const sorted = [...samples].sort((x, y) => x - y);
  const lowIdx = Math.max(0, Math.floor((alpha / 2) * sorted.length));
  const highIdx = Math.min(sorted.length - 1, Math.ceil((1 - alpha / 2) * sorted.length) - 1);
  return { low: sorted[lowIdx], high: sorted[highIdx] };
}
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}
/** Paired bootstrap for the mean of per-task differences (treatment minus control, same task); an interval excluding zero is the bar for a real difference. */
export function pairedBootstrap(diffs, opts = {}) {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  if (diffs.length === 0)
    return { estimate: 0, low: 0, high: 0, iterations: 0 };
  const rand = seededRandom(opts.seed ?? 1);
  const n = diffs.length;
  const samples = [];
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let i = 0; i < n; i++)
      s += diffs[Math.floor(rand() * n)];
    samples.push(s / n);
  }
  return { estimate: mean(diffs), ...percentileInterval(samples, alpha), iterations };
}
/** Cluster bootstrap for the mean of per-task differences: resamples whole clusters (e.g. one repository), because tasks in a cluster are not independent. */
export function clusteredPairedBootstrap(diffsByCluster, opts = {}) {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const clusters = [...diffsByCluster.values()].filter((c) => c.length > 0);
  const all = clusters.flat();
  if (all.length === 0)
    return { estimate: 0, low: 0, high: 0, iterations: 0 };
  const rand = seededRandom(opts.seed ?? 1);
  const k = clusters.length;
  const samples = [];
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < k; i++) {
      const c = clusters[Math.floor(rand() * k)];
      for (const d of c)
        sum += d;
      count += c.length;
    }
    samples.push(count === 0 ? 0 : sum / count);
  }
  return { estimate: mean(all), ...percentileInterval(samples, alpha), iterations };
}
function costPerResolved(outcomes) {
  const resolved = outcomes.filter((o) => o.resolved).length;
  const cost = outcomes.reduce((s, o) => s + o.cost, 0);
  return resolved === 0 ? Number.POSITIVE_INFINITY : cost / resolved;
}
/** Cost per resolved task in two arms on the same tasks, with a paired bootstrap (`control[i]` and `treatment[i]` must be the same task).
*  Resamples in which an arm resolves nothing are dropped; `iterations` reports how many were kept. */
export function costPerResolvedDelta(control, treatment, opts = {}) {
  if (control.length !== treatment.length) {
    throw new Error('control and treatment must list the same tasks in the same order');
  }
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const c = costPerResolved(control);
  const t = costPerResolved(treatment);
  const rand = seededRandom(opts.seed ?? 1);
  const n = control.length;
  const deltas = [];
  const relatives = [];
  for (let b = 0; b < iterations && n > 0; b++) {
    const cs = [];
    const ts = [];
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rand() * n);
      cs.push(control[j]);
      ts.push(treatment[j]);
    }
    const cc = costPerResolved(cs);
    const tt = costPerResolved(ts);
    if (!Number.isFinite(cc) || !Number.isFinite(tt))
      continue;
    deltas.push(tt - cc);
    relatives.push((tt - cc) / cc);
  }
  const finite = Number.isFinite(c) && Number.isFinite(t);
  const empty = { low: Number.NaN, high: Number.NaN };
  return {
    control: c,
    treatment: t,
    delta: {
      estimate: finite ? t - c : Number.NaN,
      ...(deltas.length > 0 ? percentileInterval(deltas, alpha) : empty),
      iterations: deltas.length,
    },
    relative: {
      estimate: finite ? (t - c) / c : Number.NaN,
      ...(relatives.length > 0 ? percentileInterval(relatives, alpha) : empty),
      iterations: relatives.length,
    },
  };
}
/** pass@k: share of tasks with at least one success in their first k runs.
*  NaN when no task has k runs (not measured, which is not the same as 0). */
export function passAtK(runsByTask, k) {
  const eligible = runsByTask.filter((r) => r.length >= k);
  if (eligible.length === 0)
    return Number.NaN;
  return eligible.filter((r) => r.slice(0, k).some(Boolean)).length / eligible.length;
}
/** pass^k: share of tasks whose first k runs all succeed (consistency).
*  NaN when no task has k runs. */
export function passHatK(runsByTask, k) {
  const eligible = runsByTask.filter((r) => r.length >= k);
  if (eligible.length === 0)
    return Number.NaN;
  return eligible.filter((r) => r.slice(0, k).every(Boolean)).length / eligible.length;
}
/** The result with nothing to test: estimate, bounds and p all NaN. */
export function notANumber(nullValue, dropped) {
  const nan = Number.NaN;
  return { estimate: nan, low: nan, high: nan, p: nan, iterations: 0, dropped, nullValue };
}
function resampleUnits(repos, rand, fixedRepositories) {
  const units = [];
  for (let i = 0; i < repos.length; i++) {
    const repo = fixedRepositories ? repos[i] : repos[Math.floor(rand() * repos.length)];
    for (let j = 0; j < repo.length; j++) {
      for (const unit of repo[Math.floor(rand() * repo.length)])
        units.push(unit);
    }
  }
  return units;
}
// Inclusive on both sides, as the p-value is worded; float noise around the null breaks a tie.
function twoSidedP(samples, nullValue) {
  let below = 0;
  let above = 0;
  for (const s of samples) {
    if (s <= nullValue)
      below++;
    if (s >= nullValue)
      above++;
  }
  return Math.min(1, (2 * Math.min(below, above)) / samples.length);
}
/** Resamples repositories, then families inside each; only the repository draw carries a shared-store fault.
* The statistic never uses the PRNG, so a second call on one seed draws the same resamples. */
export function twoLevelBootstrap(repos, statistic, opts = {}) {
  const requested = opts.iterations ?? DEFAULT_TWO_LEVEL_ITERATIONS;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new RangeError(`iterations must be a positive integer, got ${requested}`);
  }
  const nullValue = opts.nullValue ?? 0;
  const kept = repos.map((r) => r.filter((f) => f.length > 0)).filter((r) => r.length > 0);
  if (kept.length === 0)
    return notANumber(nullValue, 0);
  const rand = seededRandom(opts.seed ?? 1);
  const samples = [];
  for (let b = 0; b < requested; b++) {
    const value = statistic(resampleUnits(kept, rand, opts.fixedRepositories ?? false));
    if (Number.isFinite(value))
      samples.push(value);
  }
  const dropped = requested - samples.length;
  if (samples.length === 0)
    return notANumber(nullValue, dropped);
  const estimate = statistic(kept.flatMap((r) => r.flat()));
  const p = kept.length < 2 ? Number.NaN : twoSidedP(samples, nullValue);
  const interval = percentileInterval(samples, opts.alpha ?? DEFAULT_ALPHA);
  return { estimate, ...interval, p, iterations: samples.length, dropped, nullValue };
}
/** Holm step-down in input order; the family size is `ps.length`, as preregistered.
* A NaN stays NaN but ranks as 1, so it never loosens the others; a finite p outside [0, 1] throws. */
export function holmAdjust(ps) {
  for (const p of ps) {
    if (!Number.isNaN(p) && !(p >= 0 && p <= 1))
      throw new RangeError(`p-value out of range: ${p}`);
  }
  const ranked = ps
    .map((p, index) => ({ index, key: Number.isNaN(p) ? 1 : p }))
    .sort((a, b) => a.key - b.key || a.index - b.index);
  const adjusted = Array.from({ length: ps.length }, () => Number.NaN);
  let running = 0;
  ranked.forEach(({ index, key }, rank) => {
    running = Math.max(running, (ps.length - rank) * key);
    if (!Number.isNaN(ps[index]))
      adjusted[index] = Math.min(1, running);
  });
  return adjusted;
}
/** Checks in the preregistered order; the null comes from `e.nullValue`, so p and sides cannot disagree.
* A NaN estimate, p or bound is inconclusive, since a win or loss cannot be ruled out. */
export function verdict(e, adjustedP, spec) {
  const inconclusive = { verdict: 'inconclusive', reachesMinimum: false };
  if ([adjustedP, e.estimate, e.low, e.high].some(Number.isNaN))
    return inconclusive;
  const nullValue = e.nullValue;
  const lowerIsHelpful = spec.helpful === 'lower';
  if (adjustedP < (spec.alpha ?? DEFAULT_ALPHA)) {
    const helpfulSide = lowerIsHelpful ? e.estimate < nullValue : e.estimate > nullValue;
    const harmfulSide = lowerIsHelpful ? e.estimate > nullValue : e.estimate < nullValue;
    if (harmfulSide)
      return { verdict: 'loss', reachesMinimum: false };
    if (helpfulSide) {
      const reaches = lowerIsHelpful ? e.estimate <= spec.minimumEffectAt : e.estimate >= spec.minimumEffectAt;
      return { verdict: 'win', reachesMinimum: reaches };
    }
  }
  const insideBand = e.low >= spec.tieBand[0] && e.high <= spec.tieBand[1];
  return insideBand ? { verdict: 'tie', reachesMinimum: false } : inconclusive;
}
/** A win must hold under both codings of not-applicable, while a loss under either is reported. */
export function combineCodings(a, b) {
  if (a.verdict === 'loss' || b.verdict === 'loss')
    return { verdict: 'loss', reachesMinimum: false };
  if (a.verdict === 'win' && b.verdict === 'win') {
    return { verdict: 'win', reachesMinimum: a.reachesMinimum && b.reachesMinimum };
  }
  if (a.verdict === 'tie' && b.verdict === 'tie')
    return { verdict: 'tie', reachesMinimum: false };
  return { verdict: 'inconclusive', reachesMinimum: false };
}
/** Cost ratio's upper bound below 1.10, resolve difference's lower bound (a fraction) above -0.05.
* Both estimates must use alpha 0.05, the conservative reading of "upper 95% bound"; a NaN bound fails. */
export function harmGate(costRatio, resolveDiff) {
  const costOk = costRatio.high < 1.1;
  const resolveOk = resolveDiff.low > -0.05;
  return { pass: costOk && resolveOk, costOk, resolveOk };
}
