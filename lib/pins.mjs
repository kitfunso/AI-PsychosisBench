// The tool versions every Z0 record names, and the --pins check that keeps chunked runs on one Claude Code and model.

/** The leading version number of `claude --version` output, or null. */
export const claudeVersionToken = (out) => /^\s*(\d+(?:\.\d+)*)(?=\s|$)/.exec(String(out))?.[1] ?? null;

/** The pins a run's start differs from, one line each; a key in `actual` that the pins file lacks counts as a difference. */
export function pinMismatches(pins, actual) {
  const bad = [];
  for (const [key, value] of Object.entries(actual)) {
    if (pins[key] === undefined) bad.push(`${key} is not pinned`);
    else if (String(pins[key]) !== String(value)) bad.push(`${key} is pinned ${pins[key]}, this run has ${value}`);
  }
  return bad;
}

/** What --pins compares before any session spends usage; Claude Code's version is its leading token, so "2.1.288 (Claude Code)" pins as 2.1.288. */
export const claudePinned = (ctx) => ({ claudeVersion: claudeVersionToken(ctx.claudeVersion), model: ctx.model });

/** Throws when a pins file is given and the run differs from it. */
export function refuseOffPins(pins, actual) {
  if (!pins) return;
  const bad = pinMismatches(pins, actual);
  if (bad.length) throw new Error(`this run differs from --pins: ${bad.join('; ')}`);
}
