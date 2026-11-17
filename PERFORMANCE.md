# Round 2 performance measurements

## Round 3 CPU baseline (2026-11-17)

`test/workload-cpu.ts` runs the sealed workloads against a separate server process and samples that process's `process.cpuUsage()` over IPC at round boundaries. CPU is the average of rounds 2–5 (excluding setup, warm-up and round one), then the median across three fresh processes. Client CPU is excluded; background JIT and GC are included. A snapshot can race at most one request in the following round.

Starting runtime `1bb820e`: push p50 56.253 ms / CPU 32.308 ms; clone 20.859 / 14.644; read 110.399 / 21.150; write 17.871 / 4.439. These warmed standalone timings are separate from full grading. A fresh baseline full grade passed 120/120 and replay, score 1000, perf_p50_us 53767 (push 77.760 ms, clone 21.964, read 190.114, write 25.739).

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
