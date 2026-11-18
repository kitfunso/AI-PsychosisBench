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
| A5 | the memory under test with a new namespace for each task, so it cannot carry a lesson (the decoy) |

Gates G1 to G5 check that the run is valid. A run with a failed gate gets no score. A valid run gets two numbers, each a difference in the share of lessons failed on the first try, with a 95% interval:

- **vs built-in** (H1): A2 minus A1. Below zero means the memory repeats fewer mistakes than Claude Code's built-in memory.
- **learns**: A2 minus A5. Below zero means the memory helps because it carries lessons, not because it is installed.

The leaderboard is `docs/index.html`. It reads `docs/leaderboard.json`, which `node lib/leaderboard.mjs` builds from the `score --json` files that `docs/scores/rows.json` lists. Round 3 gives hippo 1.71.0 its row: learns +0.009 [-0.052, 0.070], vs built-in -0.149 [-0.243, -0.055].

## Run it

Version 1 runs on Windows only, with Git Bash, Node.js and the tools that `doctor` lists. The pins are Claude Code 2.1.288 and `claude-opus-5-5`.

Each Python repo runs in its own venv under `--out`, as in round 3. Without Windows long paths, a path stops at 260 characters, so keep `--out` short.

A run signs in with either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Set one of them. If both are set, the run stops.

| split | repos | setups | sessions | cost | result |
|---|---|---|---|---|---|
| lite | 8 | built-in, memory and decoy (A1, A2, A5), seed 1 | about 287 | about $97 | no score; a smoke run |
| full | 29 | all five | about 4,408 | about $1,504 at API list price | a ranked row |

The session and dollar figures come from round 3 wave 1.

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
