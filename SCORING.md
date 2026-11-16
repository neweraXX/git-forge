# Scoring and validation

The sealed sources in `kit/program/env/src/manifest.ts` and `kit/program/scorer/score.ts` define 120 equally weighted conformance checks. Each pass adds five feature points. The group counts are Git 30, repositories 15, issues 15, pull requests 20, GraphQL 20, MCP 15 and protocol 5.

Feature is `round(600 * passed / total)`. Agent is `round(200 * mcpPassed / mcpTotal)`. Therefore each MCP check is worth approximately 18.33 total points, while every other conformance check is worth five. The implementation order was shared REST storage and MCP first, Git second, GraphQL third, then performance. This reached 655, 905 and 1000 points at successive milestones.

Performance adds four independently rounded workload scores:

`round(clamp(25 - 12.5 * log2(median_ms / reference_ms), 0, 50))`

Each workload runs five warm-ups and three timed rounds. Its median enters the formula. A failed or timed-out workload earns zero. The workloads and sealed reference medians are:

| Workload | Work per round | Reference median (ms) |
| --- | --- | ---: |
| Push | 200 sequential pushes, each a 1 KiB change | 1640.820 |
| Clone | 50 concurrent depth-one clones of 200-commit history | 266.941 |
| Read | 2000 sequential issue GETs on keep-alive connections | 2759.715 |
| Write | 200 sequential issue creations | 348.965 |

A workload at the reference time earns 25 points, and one at a quarter of that time earns 50. The calibrated house forge passes 120/120 and consequently earns approximately `600 + 200 + 100 = 900` on a run at those medians. Its actual final score will depend on the final sandbox timings. A paid entry must have a strictly greater mean final score and a 90% paired t-interval of its three per-instance leads entirely above zero. The house always reaches the three-instance final and occupies its rank without taking a prize.

Exactly equal scores are ordered by `perf_p50_us`, then receipt time. That timing is the rounded geometric mean of the four workload medians, multiplied by 1000. The replay-sensitive state export holds check bits and static performance tiers, while measurements live in a separate performance export.

Local milestones all reproduced their state exports byte for byte on replay:

| Milestone | Feature | Agent | Perf | Score | Timing (us) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shared REST and MCP | 355 | 200 | 100 | 655 | 85893 |
| Git smart HTTP | 505 | 200 | 200 | 905 | 70527 |
| GraphQL complete | 600 | 200 | 200 | 1000 | 73875 |
| Immutable metadata/closure caches | 600 | 200 | 200 | 1000 | 62860 |

The all-pass state export SHA-256 is `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`, also the hash published for the complete house conformance result. Local timing runs use the supplied helper's Node 22 process driver inside its network-less container; production sandbox timings can differ.

The local helper supplies no transcript bundle, so its authorship report says zero coverage with `no_transcripts`, `coverage_below_gate` and `cost_unpriced`. These do not describe runtime conformance. Submission still needs the authentic recorded session that wrote this implementation. No transcript or usage record is fabricated or committed here.

The kit's CLI counts distinct normalized lines with at least three alphanumeric characters, accounts for generated/license/vendor exclusions and starter lines according to its authorship version, and traces surviving lines back to agent writes/edits. Copied or merely read code is not authored. The entrypoint also needs authored content, and the transcript gate checks revision history, timestamps, recorded usage and the required assistant turns. The runtime implementation was authored through edits in this session; no implementation was copied from the kit.
