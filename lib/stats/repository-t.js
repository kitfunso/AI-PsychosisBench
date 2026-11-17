/** Student t tests for the built-in memory eval. The repositories are fixed and the family is the unit (Amendment 2): a variance-components
*  t over family-by-seed tables with Satterthwaite df, plus the older one-value-per-repository tests (G-1 df).
*  The t distribution is written here because the package carries no statistics library. */
import { notANumber } from './eval-stats.js';
const ALPHA = 0.05;
// Equal repository values can leave float noise in the spread; at this size it reads as no spread at all.
const FLAT = 1e-12;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
/** log Gamma(z) for z >= 0.5, by the Lanczos series (g 7, nine terms). */
export function lnGamma(z) {
  const x = z - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++)
    a += LANCZOS[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
// Modified Lentz on the incomplete beta continued fraction; it converges fast where x < (a + 1) / (a + b + 2).
function betaFraction(a, b, x) {
  const tiny = 1e-300;
  const nonZero = (v) => (Math.abs(v) < tiny ? tiny : v);
  let c = 1;
  let d = 1 / nonZero(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 / nonZero(1 + even * d);
    c = nonZero(1 + even / c);
    h *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 / nonZero(1 + odd * d);
    c = nonZero(1 + odd / c);
    h *= d * c;
    if (Math.abs(d * c - 1) < 1e-15)
      return h;
  }
  throw new Error(`incomplete beta did not converge at a ${a}, b ${b}, x ${x}`);
}
/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x, a, b) {
  if (x <= 0)
    return 0;
  if (x >= 1)
    return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}
// Two-sided tail P(|T| >= |t|), from the beta form so a small p never loses digits to 1 - cdf.
const twoSidedTail = (t, df) => incompleteBeta(df / (df + t * t), df / 2, 0.5);
/** Student t cumulative distribution P(T <= t) with `df` degrees of freedom. */
export function studentTCdf(t, df) {
  const tail = twoSidedTail(t, df) / 2;
  return t > 0 ? 1 - tail : tail;
}
/** Student t quantile: the t with P(T <= t) = p, found by bisection on the CDF. */
export function studentTQuantile(p, df) {
  if (!(p > 0 && p < 1) || !(df > 0))
    throw new RangeError(`studentTQuantile needs 0 < p < 1 and df > 0, got p ${p}, df ${df}`);
  if (p < 0.5)
    return -studentTQuantile(1 - p, df);
  let hi = 1;
  while (studentTCdf(hi, df) < p)
    hi *= 2;
  let lo = 0;
  for (let i = 0; i < 200 && hi - lo > 1e-15 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p)
      lo = mid;
    else
      hi = mid;
  }
  return (lo + hi) / 2;
}
const critical = new Map();
// The sizer asks for the same few df thousands of times; Satterthwaite df are fractional, so the key is df to
// three decimals and the quantile is taken at that rounded df, or the cache would never hit.
function criticalValue(df) {
  const key = Math.round(df * 1000) / 1000;
  let q = critical.get(key);
  if (q === undefined) {
    q = studentTQuantile(1 - ALPHA / 2, key);
    critical.set(key, q);
  }
  return q;
}
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
/** A 95% t interval and a two-sided p against `nullValue`.
*  With no spread the interval is the estimate itself, and p is 1 on the null and 0 off it. */
function tResult(estimate, se, df, nullValue) {
  if (!Number.isFinite(estimate) || !Number.isFinite(se))
    return notANumber(nullValue, 0);
  const base = { estimate, iterations: 0, dropped: 0, nullValue, df };
  if (se <= FLAT * Math.max(1, Math.abs(estimate))) {
    const onNull = Math.abs(estimate - nullValue) <= FLAT * Math.max(1, Math.abs(nullValue));
    return { ...base, low: estimate, high: estimate, p: onNull ? 1 : 0, se: 0 };
  }
  const half = criticalValue(df) * se;
  return { ...base, low: estimate - half, high: estimate + half, p: twoSidedTail((estimate - nullValue) / se, df), se };
}
/** One-sample t test on per-repository values: the mean, se = sd / sqrt(G), G-1 degrees of freedom.
*  Fewer than two repositories give the not-a-number result. */
export function repositoryT(values, nullValue = 0) {
  const g = values.length;
  if (g < 2)
    return notANumber(nullValue, 0);
  const mean = sum(values) / g;
  const sd = Math.sqrt(sum(values.map((v) => (v - mean) ** 2)) / (g - 1));
  return tResult(mean, sd / Math.sqrt(g), g - 1, nullValue);
}
const MAX_PASSES = 1000;
const CONVERGED = 1e-12;
function tableOf(units) {
  const families = new Map();
  const seeds = new Map();
  const sums = new Map();
  const indexOf = (ids, key) => {
    if (!ids.has(key))
      ids.set(key, ids.size);
    return ids.get(key);
  };
  for (const u of units) {
    const [f, s] = [indexOf(families, u.family), indexOf(seeds, u.seed)];
    const cell = sums.get(`${f}/${s}`) ?? { f, s, total: 0, count: 0 };
    cell.total += u.value;
    cell.count++;
    sums.set(`${f}/${s}`, cell);
  }
  const cells = [...sums.values()].map((c) => ({ f: c.f, s: c.s, y: c.total / c.count }));
  return { cells, k: families.size, s: seeds.size };
}
function levelMeans(cells, size, level, value) {
  const total = Array.from({ length: size }, () => 0);
  const count = Array.from({ length: size }, () => 0);
  for (const c of cells) {
    total[level(c)] += value(c);
    count[level(c)]++;
  }
  return total.map((x, i) => x / count[i]);
}
// Writes the centred effects into `effects` and returns the shift, which belongs to the intercept.
function centreInto(effects, raw) {
  const shift = sum(raw) / raw.length;
  raw.forEach((x, i) => {
    effects[i] = x - shift;
  });
  return shift;
}
/** Residual sum of squares about the level means of one factor: the fit with the other factor left out. */
function rssAbout(cells, size, level) {
  const means = levelMeans(cells, size, level, (c) => c.y);
  return sum(cells.map((c) => (c.y - means[level(c)]) ** 2));
}
/** Least squares for y = mu + a_f + b_s on the cells present, by alternating means with a and b centred each pass. */
function additiveFit(repo, t) {
  const a = Array.from({ length: t.k }, () => 0);
  const b = Array.from({ length: t.s }, () => 0);
  let mu = sum(t.cells.map((c) => c.y)) / t.cells.length;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = [mu, ...a, ...b];
    const shiftA = centreInto(a, levelMeans(t.cells, t.k, (c) => c.f, (c) => c.y - mu - b[c.s]));
    mu += shiftA;
    const shiftB = centreInto(b, levelMeans(t.cells, t.s, (c) => c.s, (c) => c.y - mu - a[c.f]));
    mu += shiftB;
    mu = sum(t.cells.map((c) => c.y - a[c.f] - b[c.s])) / t.cells.length;
    const change = Math.max(...[mu, ...a, ...b].map((x, i) => Math.abs(x - before[i])));
    if (change < CONVERGED)
      return { mu, rss: sum(t.cells.map((c) => (c.y - mu - a[c.f] - b[c.s]) ** 2)) };
  }
  throw new Error(`additive fit for repository ${repo} did not converge in ${MAX_PASSES} passes`);
}
// Union-find over the family-seed graph: n - k - s + 1 counts residual df only when the present cells form one block.
function isConnected(t) {
  const parent = Array.from({ length: t.k + t.s }, (_, i) => i);
  const root = (i) => {
    while (parent[i] !== i)
      i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const c of t.cells)
    parent[root(c.f)] = root(t.k + c.s);
  return new Set(parent.map((_, i) => root(i))).size === 1;
}
/** sigma_e^2 weight of the additive fit's mu, [(X'X)^-1]_00 under effect coding; 1 / n only when the table is complete. */
function meanNoiseWeight(t) {
  const p = t.k + t.s - 1;
  const a = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j === p && i === 0 ? 1 : 0)));
  const code = (level, size, offset, x) => {
    for (let j = 0; j < size - 1; j++)
      x[offset + j] = level === size - 1 ? -1 : level === j ? 1 : 0;
  };
  for (const c of t.cells) {
    const x = Array.from({ length: p }, () => 0);
    x[0] = 1;
    code(c.f, t.k, 1, x);
    code(c.s, t.s, t.k, x);
    for (let i = 0; i < p; i++)
      for (let j = 0; j < p; j++)
        a[i][j] += x[i] * x[j];
  }
  // Gauss-Jordan on the positive definite X'X (a fitted table is connected), so no pivoting is needed.
  for (let i = 0; i < p; i++) {
    const row = a[i];
    const pivot = row[i];
    for (let j = i; j <= p; j++)
      row[j] /= pivot;
    for (let r = 0; r < p; r++) {
      if (r === i)
        continue;
      const factor = a[r][i];
      for (let j = i; j <= p; j++)
        a[r][j] -= factor * row[j];
    }
  }
  return a[0][p];
}
// A thin repository's estimate is its plain cell mean, so each family and seed weighs by its share of the cells.
function plainWeights(t) {
  const shares = (size, level) => {
    const count = Array.from({ length: size }, () => 0);
    for (const c of t.cells)
      count[level(c)]++;
    return sum(count.map((x) => (x / t.cells.length) ** 2));
  };
  return { family: shares(t.k, (c) => c.f), seed: shares(t.s, (c) => c.s), noise: 1 / t.cells.length };
}
function fitRepo(repo, units) {
  const t = tableOf(units);
  const n = t.cells.length;
  const dfE = n - t.k - t.s + 1;
  const base = { k: t.k, s: t.s, n };
  if (t.k < 2 || t.s < 2 || dfE < 1 || !isConnected(t))
    return { ...base, est: sum(t.cells.map((c) => c.y)) / n, w: plainWeights(t), ms: null };
  const { mu, rss } = additiveFit(repo, t);
  // mu carries the unweighted mean of the family and seed effects present, whatever cells are missing.
  const w = { family: 1 / t.k, seed: 1 / t.s, noise: meanNoiseWeight(t) };
  const [dfF, dfQ] = [t.k - 1, t.s - 1];
  // Clamped: both reduced fits nest the additive one, so a negative difference is float noise.
  const ssF = Math.max(0, rssAbout(t.cells, t.s, (c) => c.s) - rss);
  const ssQ = Math.max(0, rssAbout(t.cells, t.k, (c) => c.f) - rss);
  return { ...base, est: mu, w, ms: { F: ssF / dfF, Q: ssQ / dfQ, E: rss / dfE, dfF, dfQ, dfE } };
}
const weighted = (rs, value, df) => sum(rs.map((r) => value(r) * df(r))) / sum(rs.map(df));
function poolMeanSquares(fitted) {
  return {
    F: weighted(fitted, (r) => r.ms.F, (r) => r.ms.dfF),
    Q: weighted(fitted, (r) => r.ms.Q, (r) => r.ms.dfQ),
    E: weighted(fitted, (r) => r.ms.E, (r) => r.ms.dfE),
    dfF: sum(fitted.map((r) => r.ms.dfF)),
    dfQ: sum(fitted.map((r) => r.ms.dfQ)),
    dfE: sum(fitted.map((r) => r.ms.dfE)),
    // E[F] = E + sBar sigma_a^2 with sBar = sum(n - s) / sum(k - 1) for one-unit cells (Henderson III); n / k only when complete.
    sBar: sum(fitted.map((r) => r.n - r.s)) / sum(fitted.map((r) => r.ms.dfF)),
    kBar: sum(fitted.map((r) => r.n - r.k)) / sum(fitted.map((r) => r.ms.dfQ)),
  };
}
function fitAll(units) {
  const byRepo = new Map();
  for (const u of units) {
    const list = byRepo.get(u.repo);
    if (list)
      list.push(u);
    else
      byRepo.set(u.repo, [u]);
  }
  const repos = [...byRepo].map(([repo, us]) => fitRepo(repo, us));
  return { repos, fitted: repos.filter((r) => r.ms !== null) };
}
/** The pooled mean squares the fixed-repository t test reads, for one repository or more; null when none can be fitted.
*  The seed rule and the sizer take their spreads from here, so they cannot drift from the test. */
export function pooledComponents(units) {
  const { repos, fitted } = fitAll(units);
  if (fitted.length === 0)
    return null;
  return { repos: repos.map(({ k, s, n }) => ({ k, s, n })), ...poolMeanSquares(fitted) };
}
// Variance of the mean of the G repository estimates, with Satterthwaite df. Every repository adds its own
// coefficients (fitted or not); the mean squares are pooled over the fitted ones, weighted by df.
function varianceOf(repos, fitted) {
  const g = repos.length;
  const { F, Q, E, dfF, dfQ, dfE, sBar, kBar } = poolMeanSquares(fitted);
  const useQ = Q > E;
  let [cF, cQ, cE] = [0, 0, 0];
  for (const r of repos) {
    const family = r.w.family / sBar;
    cF += family;
    cE += r.w.noise - family;
    if (useQ) {
      const seed = r.w.seed / kBar;
      cQ += seed;
      cE -= seed;
    }
  }
  const terms = [[(cF * F) / (g * g), dfF], [(cQ * Q) / (g * g), dfQ], [(cE * E) / (g * g), dfE]].filter(([x]) => x !== 0);
  const v = sum(terms.map(([x]) => x));
  if (v > 0)
    return { v, df: (v * v) / sum(terms.map(([x, d]) => (x * x) / d)) };
  return { v: (cF * F) / (g * g), df: dfF };
}
/** Mean of the repository estimates with repositories held fixed: the spread is family and seed variation inside each
*  (additive model y = mu + a_f + b_s), pooled over fitted repositories (two or more families and seeds in one connected
*  block, one residual df); a thinner or split one adds its mean and borrows the pooled spread. Fewer than two repositories or none fitted: NaN. */
export function fixedRepositoryT(units, nullValue = 0) {
  if (units.some((u) => !Number.isFinite(u.value)))
    return notANumber(nullValue, 0);
  const { repos, fitted } = fitAll(units);
  if (repos.length < 2 || fitted.length === 0)
    return notANumber(nullValue, 0);
  const { v, df } = varianceOf(repos, fitted);
  return tResult(sum(repos.map((r) => r.est)) / repos.length, Math.sqrt(v), df, nullValue);
}
/** The pooled ratio sum(t) / sum(c) against 1; its spread is fixedRepositoryT on the residuals (t - R c) / mean(c).
*  The interval is on the log scale (`se` too): with skewed costs the symmetric R +- t se passed 5.2-5.6% at a true
*  1.10, over the 5% bar, and the log form passed 3.2-4.7%. */
export function fixedRepositoryRatioT(cells) {
  const [totalT, totalC] = [sum(cells.map((x) => x.t)), sum(cells.map((x) => x.c))];
  if (!(totalT > 0 && totalC > 0))
    return notANumber(1, 0);
  const ratio = totalT / totalC;
  const cBar = totalC / cells.length;
  const residuals = cells.map(({ repo, family, seed, t, c }) => ({ repo, family, seed, value: (t - ratio * c) / cBar }));
  const { se, df } = fixedRepositoryT(residuals, 0);
  if (se === undefined || df === undefined || !Number.isFinite(se))
    return notANumber(1, 0);
  const log = tResult(Math.log(ratio), se / ratio, df, 0);
  return { ...log, estimate: ratio, low: Math.exp(log.low), high: Math.exp(log.high), nullValue: 1 };
}
