# Round 3 verdict table

`outcomes.jsonl` holds one row for each task record of round 3: 4,862 rows, of which 4,345 are scored. It holds the verdicts and the exclusion flags that the paper's tables need. It holds no transcripts, prompts, session ids, token counts or costs.

`tables.mjs` rebuilds Figure 1 and Tables 3, 4 and 5 of the paper from this file alone. It uses the frozen analyser's functions in `lib/`.

```bash
npm ci
node round3/tables.mjs          # the figure and the three tables as text
node round3/tables.mjs --json   # the same values as JSON
```

The rebuild gives the same value for every cell of Figure 1 and Tables 3 to 5 as the paper. `test/round3-tables.test.ts` checks the main values.

## Columns

| Column | Meaning |
|---|---|
| `repo` | The upstream GitHub repository of the task. |
| `sequence`, `seed`, `position` | The task sequence (one per repository), the seed (1 to 3) and the task's place in the sequence. |
| `arm` | A0 no memory, A1 built-in memory, A2 full hippo, A5 hippo with saving off, A4 perfect memory. |
| `set`, `kind`, `tool` | Set R (lesson tasks) or N (no-lesson tasks); `teach`, `apply` or `no-lesson`; the agent. |
| `taskId`, `familyId` | The task and its family in the published dataset. |
| `lessonSource` | `maintainer` (a rule from the repository's own docs) or `template`. |
| `applyIndex` | 1 for a family's first apply task, 2 or more for later ones. |
| `tasksSinceTeach`, `afterReversal` | Tasks since the family's teach task, and whether the rule changed before this task. |
| `resolved` | The task passed its acceptance check and every lesson check. |
| `lessons[].first` | The first-attempt lesson verdict: `pass`, `fail` or `na`. Violation coding counts `na` as a fail. Excluded coding drops it. |
| `run` | `wave-1`, or `amendment-e-rerun` for the six sequence-seeds that ran again under Amendment E. |
| `excluded` | `null` for a scored row. Otherwise the reason: `leak-run`, `invalid` or `void-position`. |
| `promptHookCancel`, `anyHookCancel` | A cancelled prompt hook, or any cancelled hook, at this position in an A2 or A5 transcript. The sensitivity rows drop these positions in every arm. |
| `rerunSeed`, `python`, `returningRepo` | The sequence-seed ran again under Amendment E; the repository is a Python repository; the repository was also in round 2. |

## How the file was made

`export.mjs` wrote the file from the private run records. It reads the same 35 runs files, plans and grading file as the frozen final read, with the rule in that read's script. The grading file and the prompt-hook list are public in the hippo repository at commit `17d2e5b92`, as `docs/evals/z0-r3/grading.json` and `docs/evals/z0-r3/drop-list-sensitivity.json`. Before it writes, the script makes these checks and stops if one fails:

- Its exclusion reasons give the same scored rows as the analyser's `filterRecords`.
- A drop by the hook flags gives the same rows as `filterRecords` with the same positions as its drop list.
- Each prompt-hook position has a cancel record in the transcripts.

The transcripts stay private, because they hold the full sessions. The paper's audit counts (Table 6) read them, so this file cannot rebuild that table.

Licence: CC-BY-4.0, the same as the task files.
