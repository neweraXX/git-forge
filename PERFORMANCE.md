# Performance measurements

## Round 3 results (2026-11-17)

The starting runtime is `1bb820e`; retained runtime changes end at `86d26b7`. `test/workload-cpu.ts` runs the sealed workloads against a separate server process and samples its `process.cpuUsage()` over IPC. CPU is the average of rounds 2–5, then the median across three fresh processes; setup, warm-up and round one are excluded. Client CPU is excluded; background JIT and GC are included. Sequential requests can race one snapshot; a concurrent clone burst can straddle a boundary. The harness also records whole-workload CPU including setup.

Final paired comparison (three fresh processes per version, five rounds per workload):

| Workload | Before p50 ms | After p50 ms | Before server CPU ms/round | After server CPU ms/round |
| --- | ---: | ---: | ---: | ---: |
| Push | 49.102 | 38.761 | 33.245 | 19.079 |
| Clone | 18.433 | 18.292 | 13.457 | 9.851 |
| Read | 113.132 | 104.592 | 21.321 | 16.090 |
| Write | 18.761 | 17.566 | 4.059 | 4.111 |

Standalone geometric means were 37229→33784 us. CPU fell approximately 43% for push, 27% for clone and 25% for read; write CPU was effectively flat. These warmed standalone timings are not full-grade timings.

The initial one-instance full grade measured 53767 us (push 77.760 ms, clone 21.964, read 190.114, write 25.739). Final `./dock node test/grade-three.ts` measured **53204, 54918, 55991 us**, averaging **54704.333333 us**. All three passed 120/120 checks, scored feature 600 + agent 200 + perf 200 = **1000**, and matched replay byte for byte with the unchanged all-pass export hash. Their median workload p50s were push 80.773 ms, clone 22.094, read 187.926, write 27.207. This is not a matched three-instance baseline comparison. The requested **40000 us full-grade target was not reached**, and no real-server regrade was performed.

Retained changes:

- Reuse socket request records, skip unused header values and reuse parsed byte-identical bodyless GET headers. Every request still authenticates and routes against current store state.
- Reuse a native inflater across independent Git zlib streams, with the public one-shot API as a fallback. Checksums, object sizes/hashes, delta resolution and graph validation remain enforced. The inflater test covers levels 0/1/6/9, empty through 1 MiB objects, both entropies, trailing bytes, corruption, truncation, overflow and recovery.
- Native socket read/write adapters avoid intermediate stream queues and reuse synchronous write wrappers. Queued writes retain their bytes and pause parsing until completion; asynchronous completions get a fresh wrapper before resuming. These paths depend on Node internals and fall back to normal stream APIs when their layouts are unavailable. `FORGE_READER=stream` and `FORGE_WRITER=stream` force the fallbacks. Transport tests cover all four combinations, including 16 MiB backpressure, fragmentation, trailers, pipelining and GET mutation/auth invalidation.
- One-shot SHA-1 for small objects and packs, direct hexadecimal packet-length parsing, one final advertisement encoding, and allocation-free immediate-parent fast-forward checks.

Discarded: dynamic semi-space flags, larger semi-spaces supplied at process startup, compiler/GC tuning, cached user records, custom issue serialization, header-prefix caching and single-allocation creation responses. None clearly improved workload CPU overall. Changing GC mode dynamically also crashed the diagnostic process; no V8 flags are deployed.

Reproduce with `./dock node test/workload-cpu.ts`, `test/profile-server.ts`, `test/transport-modes.ts`, `test/inflate.ts`, `test/hash-cost.ts`, and `test/grade-three.ts`. For `test/cpu-compare.ts`, first materialize `1bb820e`'s runtime .ts files under the uncommitted `repo/test/.baseline/` using `git show`; remove that snapshot afterward. All temporary comparison directories were removed before final grading. Owner metadata and README badges were untouched.

## Round 2 history

All measurements use the supplied network-less `./dock` container. No real-server regrade of the new commit was performed. The reported starting server result was score 936, perf 136 and perf_p50_us 492573; local scores remain capped at 1000, so local timing and server CPU are the useful comparisons.

## Full grader results

The starting commit is `7c51309`. Its initial `./dock grade` measured 60304 us. A later direct comparison materialized only that commit's runtime files under a temporary test directory and ran the same grader, yielding the workload medians below. That temporary directory and runner were removed after measurement; the owner file and README badges were neither copied nor changed.

| Workload | Original commit p50 ms | Optimized entry p50 ms |
| --- | ---: | ---: |
| Push, 200 operations | 101.468 | 83.988 |
| Clone, 50 concurrent clones | 25.896 | 24.632 |
| Read, 2000 operations | 226.023 | 190.087 |
| Write, 200 operations | 30.110 | 29.275 |
| Geometric mean, microseconds | 65029 | 58249 |

These are consecutive full-grade comparisons, not the warmed standalone benchmark. The improvement in that pair is 10.4%; individual runs are noisy, especially the clone and write medians.

The optimized entry also completed `./dock node test/grade-three.ts`: all three instances passed all 120 checks, scored feature 600 + agent 200 + perf 200 = 1000, and matched replay byte for byte. Their perf_p50_us values were 54774, 55400 and 54564, averaging 54912.666667. Relative to the initial 60304 us run, that is an 8.9% improvement. The all-pass export hash remains a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590.

The final repeat of the three-instance run, on the same retained implementation, measured 54210, 55520 and 58415 us, averaging 56048.333333 us. Every instance again scored 1000 and matched replay. This last aggregate is 7.1% below the initial baseline and is the final reported result; the difference between the two three-instance aggregates illustrates the remaining timing noise.

The requested 38000 us full-grade target was not reached. A warmed standalone comparison did reach 37771 us on one run, but that is a different benchmark context and is not presented as a full-grade result.

## Retained changes

- A synchronous shared router caches URL interpretation for common Git and issue routes. Repository identity and bearer authorization are checked on every request, including cached routes. Generic REST operations retain the complete URL parser and normal pagination behavior.
- The default transport uses `node:net`, parses HTTP/1.0 and HTTP/1.1 framing, and supports fragmented headers/bodies, Content-Length, chunked bodies and trailers, pipelining, backpressure and connection closure. Complete HTTP response buffers are cached by immutable response-body buffer, with bounded application caches and weak transport-cache ownership. Node's HTTP transport remains available with FORGE_HTTP=node for comparisons.
- Git pkt-lines and sideband frames use one allocation per output buffer. A push report cache is keyed by the actual computed verdict and negotiated sideband mode; every pack still undergoes checksum verification, object hashing/inflation, closure validation and ref checks before a cached report can be returned.
- Inflate output chunks are sized to small objects rather than always allocating 16 KiB. The isolated allocation test showed approximately half as many backing-buffer bytes for the mix of blob/tree/commit sizes tested.

In the first six-run alternating comparison of the lean Node HTTP transport and the TCP transport, median server CPU across the four workloads fell from 575.501 ms to 405.365 ms, with timing medians of 49929 and 41215 us. A second comparison after Git allocation changes measured 668.466 ms versus 434.995 ms of server CPU. RSS was about 102-103 MiB in that second comparison. These tests include server startup and are useful CPU comparisons, not substitutes for full grading.

The isolated packet test's warm runs fell from about 50 ms CPU to 33-35 ms for 300000 report-sized packets, roughly one-third less CPU. The cache additionally eliminates rebuilding identical push report bodies and their HTTP wrappers.

## Experiments discarded

Exact-header memoization, a regex-based header extractor, removing socket idle-timeout maintenance, and another layer of cached reply wrappers did not clearly improve full-grade timings. They were reverted. The CPU profile of the retained transport showed socket writes, garbage collection, header parsing and zlib among the remaining costs.

## Reproducing measurements

From the workspace parent:

```sh
./dock grade
./dock node test/grade-details.ts
./dock node test/grade-three.ts
./dock node test/compare-http.ts
./dock node test/profile-server.ts
./dock node test/packet-cost.ts
./dock node test/inflate-cost.ts
./dock node test/protocol.ts
./dock node test/transport.ts
```

`grade-details.ts` prints the real grader's per-workload perf.json values after grading. Diagnostic files write only under /tmp. Protocol tests additionally check malformed packs, delta packs, cross-surface cache invalidation, auth and generic GraphQL parsing. Transport tests check fragmented UTF-8, chunked framing, trailers, pipelining and conflicting length headers.
