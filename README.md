# AI-PsychosisBench

AI-PsychosisBench measures repeat mistakes by coding agents with memory. It is not a mental-health benchmark and is not related to psychosis-bench (arXiv 2509.10970).

A public repeat-mistake benchmark for coding-agent memory, cut from hippo Z0 round 3 (tag z0-r3-freeze).

## What it measures

A Claude Code agent works through task sequences in 29 open source repositories. Some tasks teach a lesson. Later tasks in the same sequence test whether the agent applies the lesson or makes the same mistake again. A check script grades each lesson.

Each task runs in five setups (arms):

| arm | setup |
|---|---|
| A0 | no memory |
| A1 | Claude Code's built-in memory |
| A2 | the memory under test |
| A4 | no memory; the taught lessons are written into `CLAUDE.md` |
| A5 | the memory under test, fully installed, with a new namespace for each task, so it cannot carry a lesson (the decoy) |

Gates G1 to G5 check that the run is valid. A run with a failed gate gets no score. A valid run gets two numbers, each a difference in the share of lessons failed on the first try, with a 95% interval:

- **vs built-in** (H1): A2 minus A1. Below zero means the memory repeats fewer mistakes than Claude Code's built-in memory.
- **learns**: A2 minus A5. Below zero means the memory helps because it carries lessons, not because it is installed.

The leaderboard is `docs/index.html`. It reads `docs/leaderboard.json`, which `node lib/leaderboard.mjs` builds from the `score --json` files that `docs/scores/rows.json` lists. Round 3 gives hippo its row, from hippo 3.3.1 as frozen for round 3 (tag `z0-r3-freeze`, commit `cb992a079`; a test build, not the `v3.3.1` release tag): learns +0.009 [-0.052, 0.070], vs built-in -0.149 [-0.243, -0.055].

## Round 3 in numbers

Round 3 is the run behind hippo's row. It ran Claude Code 2.1.288 with `claude-opus-5-5`, from 5 to 8 November 2026.

| | |
|---|---|
| Repositories | 29 open source repositories (Java, Kotlin, C#, Python, TypeScript, Go and others) |
| Code | 3,283,727 non-blank lines in code files at the snapshot commits; 5,003,132 lines in all 30,100 tracked text files |
| Lessons | 58 lesson families (44 maintainer rules, 14 template lessons), 13 of them reversed later, 71 lessons in all |
| No-lesson tasks | 174 (6 per repository) |
| Task records | 4,862: A0 748, A1 1,122, A2 1,122, A4 748, A5 1,122 |
| Claude Code sessions | 4,596 |
| Prompts | 5,880 (task prompts, teach messages and corrections) |
| Usage | $1,585.90 at API list price |

Share of lessons failed on the first try, at each lesson's first apply (violation coding, 95% interval):

| arm | failed |
|---|---|
| A0 no memory | 0.839 [0.764, 0.915] |
| A1 built-in memory | 0.265 [0.175, 0.354] |
| A2 built-in + hippo | 0.116 [0.068, 0.164] |
| A5 built-in + hippo, saving off (the decoy) | 0.107 [0.060, 0.154] |
| A4 perfect memory | 0.068 [0.006, 0.131] |

All five gates pass. Hippo against built-in memory is -0.149 [-0.243, -0.055] (Holm-adjusted p 0.006), at a cost ratio of 1.006 [0.964, 1.049]. In round 3 the decoy was hippo fully installed, with its saving turned off: the same build, hooks and `CLAUDE.md` block, but its save commands did nothing, so its store stayed empty. Full hippo against hippo with saving off is +0.009 [-0.052, 0.070]. Both arms with hippo installed cut repeat mistakes by the same amount, so the gain comes from installing hippo, and round 3 cannot credit hippo's stored lessons. Our audit points to hippo's `CLAUDE.md` block: it sent agents to Claude Code's own memory files, even when hippo had saved nothing.

The code lines are `git grep -I -c` counts over code file types at each repository's snapshot commit. Sessions are the distinct Claude Code session ids in the task records. Prompts are the typed user turns in those sessions' transcripts.

## Run it

Version 1 runs on Windows only, with Git Bash, Node.js and the tools that `doctor` lists. The pins are Claude Code 2.1.288 and `claude-opus-5-5`.

Each Python repo runs in its own venv under `--out`, as in round 3. Without Windows long paths, a path stops at 260 characters, so keep `--out` short.

A run signs in with either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Set one of them. If both are set, the run stops.

| split | repos | setups | sessions | cost | result |
|---|---|---|---|---|---|
| lite | 8 | built-in, memory and decoy (A1, A2, A5), seed 1 | about 310 | about $105 | no score; a smoke run |
| full | 29 | all five | about 4,600 | about $1,590 at API list price | a ranked row |

The session and dollar figures are round 3's own: 311 sessions and $104.61 for the lite cells, 4,596 sessions and $1,585.90 for all 4,862 task records.

The command is `ai-psychosisbench` (the `bin` in `package.json`). From a clone, run it as `node lib/cli.mjs`:

```sh
npm install
# The dataset: https://huggingface.co/datasets/kitfunso/AI-PsychosisBench
hf download kitfunso/AI-PsychosisBench --repo-type dataset --local-dir out/ai-psychosisbench-r3-v1
node lib/cli.mjs doctor --split lite          # setup and tests of each repo; no model call
node lib/cli.mjs register --memory adapters/yours.json
node lib/cli.mjs run --dataset out/ai-psychosisbench-r3-v1 --memory adapters/yours.json --model claude-opus-5-5 --out runs/yours
node lib/cli.mjs verify runs/yours
node lib/cli.mjs score --run runs/yours --memory adapters/yours.json --json yours-score.json
node lib/cli.mjs cost --run runs/yours
```

`adapters/hippo.json` is an example memory manifest. `regrade --run DIR` grades every lesson of a finished run again with the packed check scripts. Every command but `run` makes no model call.

## Add your memory to the leaderboard

1. Write a memory manifest for your memory, like `adapters/hippo.json`.
2. Run `register`. It prints the plan's sha256 and writes an issue body. Open a public issue in this repo with that body before the run starts.
3. Run the full split.
4. Run `verify` on the out dir. It checks one record for each planned cell, regrades every lesson and refuses any key-shaped value.
5. Put the `score --json` file and a link to the out dir in the issue.

## Licence

The code is MIT (see `LICENSE`). The task files and check scripts in the dataset are CC-BY-4.0. Each repository bundle keeps its own upstream licence, in the `LICENSE` file beside it.
