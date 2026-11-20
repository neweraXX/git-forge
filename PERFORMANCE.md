# Performance measurements

## Go CPU and allocation round (2026-11-20)

Starting runtime: `b93dca4`; final runtime and rebuilt binaries: `589124a`. The supplied starting production result was score 943 and perf_p50_us 447309. No production regrade was performed in this round. The requested **50% reduction in Go ENTRYCPU was not reached**: the required three-run medians improved 9.1% on two CPUs and 3.1% on one CPU. One-CPU total entry CPU increased because the unchanged Node launcher's measured CPU increased.

### Exact workload measurements

`./dock node test/go-workload-metrics.ts` imports the sealed `/kit/program/env/src/bench.ts`, runs its exact push/clone/read/write workloads, and measures the separate Go child. Each workload has 11 rounds; setup, warm-up and round one are excluded. An idle stdin diagnostics channel pauses the next round at the fetch boundary while taking `runtime.MemStats`, process `getrusage`, and `/proc/<pid>/stat` snapshots. Diagnostics are opt-in and add no counters, endpoints or branches to request handling. CPU includes Go runtime work; client CPU is excluded. One operation is one push, one complete protocol-v2 depth-1 clone, one issue GET, or one issue creation.

The final comparison interleaves three fresh baseline processes and three fresh final processes in the order before/after/after/before/before/after. The baseline binary from `0c1ae6f` is `b93dca4`'s implementation with only the same opt-in diagnostics added. That temporary baseline binary was removed after measurement. `test/perf-paired-workloads.log` contains every sample and the median of each version's three process averages. This paired comparison is the reported per-workload result; the initial and final unpaired samples remain available in separate logs, including a noisy clone regression in the final unpaired run.

| Workload | Go CPU us/op before → after | /proc CPU us/op before → after | Allocations/op before → after | Bytes allocated/op before → after |
| --- | ---: | ---: | ---: | ---: |
| Push | 27.814 → 23.924 | 30 → 25 | 60.056 → 14.023 | 6307.592 → 3471.368 |
| Clone | 25.226 → 22.254 | 20 → 20 | 13.170 → 0.020 | 685.504 → 0.320 |
| Read | 4.6865 → 4.4457 | 4.5 → 4.5 | 0.0005 → 0.0005 | 0.008 → 0.008 |
| Write | 10.9175 → 7.3450 | 10 → 10 | 31.990 → 6.032 | 3195.424 → 1436.640 |

The first CPU column uses process `getrusage` microseconds to avoid `/proc`'s 10 ms tick quantization. The independent `/proc` measurement is retained as requested. The stats command itself contributes one 16-byte allocation per round: 0.020 allocations/clone and 0.0005 allocations/read. Thus warmed clone and read application paths allocate zero. Push and write include real object/issue storage and occasional store growth, rather than just a handler microbenchmark. Paired per-round p50s were push 25.214→24.599 ms, clone 13.725→13.604, read 86.427→86.924, write 13.147→12.423. These standalone timings exclude the lifecycle forwarder and are not full-grade or production timings.

Profiles (`test/perf-baseline-profile.log`, `test/perf-final-profile.log`) identify socket/syscall work as the dominant read and clone cost. Final read samples spend 360/500 ms flat in `Syscall6`; clone's sampled CPU is entirely in syscalls. Push still spends 70/190 ms cumulatively in stdlib flate decoding, including dynamic Huffman table construction. SHA-1 is a smaller remaining cost. Regex matching, temporary headers, per-object zlib checksum objects, general JSON decoding, and temporary graph-validation maps were removed from the common paths. Profiles have substantial sampling/runtime overhead and are used only to identify functions, not to compare CPU/op.

### Required full-grade CPU repeats

These are medians of exactly three `./dock cpu` and three `./dock cpu 1` runs per version. The sampler includes live plus replay, using 10 ms CPU ticks; p50s are the live workload round times. No diagnostic environment is enabled. Full samples are in `test/perf-baseline-cpu*-run*.log` and `test/perf-final-cpu*-run*.log`; `./dock node test/summarize-performance.ts` verifies and aggregates them.

| Measurement | 2 CPUs before | 2 CPUs after | 1 CPU before | 1 CPU after |
| --- | ---: | ---: | ---: | ---: |
| Go CPU ms | 330 | 300 | 320 | 310 |
| Node CPU ms | 150 | 140 | 150 | 200 |
| Total entry CPU ms | 480 | 440 | 480 | 510 |
| Push p50 ms | 53.737 | 50.765 | 93.917 | 89.631 |
| Clone p50 ms | 19.194 | 18.465 | 39.034 | 45.488 |
| Read p50 ms | 190.375 | 184.582 | 288.793 | 291.433 |
| Write p50 ms | 24.588 | 22.700 | 26.041 | 25.041 |

Go CPU samples: two CPUs 340/330/330→290/300/300 ms; one CPU 300/340/320→310/310/310 ms. Total entry samples: two CPUs 560/480/470→440/440/440 ms; one CPU 450/480/480→490/510/510 ms. Overall entry CPU improved 8.3% on two CPUs and regressed 6.3% on one CPU. The launcher and Node fallback code were unchanged. Local wall-time and CPU variation limit conclusions about production improvement.

### Retained implementation and runtime settings

- The nonblocking epoll loop stops reading after a short successful read, avoiding the normal second read just to receive EAGAIN. It retries partial writes immediately and enables EPOLLOUT only after EAGAIN. Closing a socket removes its epoll watch without a redundant DEL syscall. Ordinary requests use one read and one write. Header parsing borrows input bytes; retained routes and memoized GET headers own their storage.
- Full immutable HTTP responses are cached for issue GET, v0/v2 advertisements, ls-refs and shallow upload-pack replies. Issue/ref mutations invalidate the corresponding caches. Advertisement and created-issue builders reserve header space and append the body once, sharing one allocation between the body and full HTTP response.
- Pack input is parsed once using pooled flate readers, SHA-1 state, digest/header storage, staged-object slices and validation slices. Zlib headers, dictionaries and Adler32 are checked explicitly, alongside the pack checksum, object sizes, hashes, deltas and graph closure. Only successfully validated objects are marked reusable. Common push verdicts use cached reports after all checks; reference/object validation no longer uses regexes or temporary maps.
- Issues have compact typed records and lazy generic materialization for REST lists, GraphQL and MCP. The common create request uses a one-pass string parser, with stdlib JSON fallback for escapes, Unicode and other input shapes. Append builders preserve the existing serialized bytes, field ordering and cross-surface mutations.

After the allocation changes, `./dock node test/cpu-tune.ts` tested eight GC/worker/thread variants three times each (`test/perf-gc-procs.log`). **GOGC=600, GOMAXPROCS=2, no explicit memory limit, locked serving thread** remains the default. Two workers/GC600 used median 280 ms Go CPU versus 340 ms with one worker. GC100 used 290 ms and four live collections; GC disabled used 280 ms with no clear improvement. Unlocking the thread did not consistently improve latency. Separate final memory diagnostics measured zero live collections and peak RSS of 21.41, 19.71 and 21.35 MiB. Their lower Go CPU samples are retained separately and do not replace the required CPU repeats above.

Discarded experiments: bounded raw epoll waits, which did not consistently improve end-to-end CPU/latency; and recvfrom/sendto in place of read/write, which lost the paired/full-grade comparison (300 versus 310 ms Go CPU). No busy spinning, raw epoll wait mode or alternate socket syscalls are deployed. Logs remain in `test/perf-wait-procs.log` and `test/perf-socket-*.log`.

### Final validation

- `./dock gobuild` passed Go vet and rebuilt both static binaries; `./dock gotest` passed all Go tests. Added regression coverage includes borrowed header ownership, cached advertisement mutation/in-flight ownership, malformed zlib/dictionaries/checksums and recovery, larger forward-delta packs, graph-validation recovery, issue JSON edge cases and cache invalidation.
- `./dock grade 3`: **120/120 checks on all three instances**, scores **1000, 1000, 1000**, every replay byte-identical. Native perf_p50_us: **46439, 49013, 41723**, mean **45725** (`test/perf-final-native.log`).
- `./dock grade-amd64 3`: **120/120 checks on all three instances**, scores **1000, 1000, 999**, every replay byte-identical. The last emulated run earned perf 199; its feature and agent scores remained 600 and 200. Emulated perf_p50_us 88442, 83545 and 96696 are correctness evidence only (`test/perf-final-amd64.log`).
- The retained-log grader separately asserted all 120 checks and verified the Go listener with no fallback in three native and three forced-amd64-binary runs (`test/perf-final-logged.log`). The 48-request Node parity comparison, protocol, epoll transport/backpressure, and all seven launcher/fallback cases passed. The all-pass state hash remains `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`.

The committed amd64 binary is 6549652 bytes, SHA-256 `78214db82cbad48ff14ba069ece9c41456d04263a1474b3c864bbb8e7430e219`; the local arm64 binary is 6160532 bytes. Runtime milestones were `42d19ab` (transport), `0b5ec3e` (push/ad parsing), `0daaad1` (issues), `703bc09` (pack pools/direct issue cache), and `589124a` (complete advertisement builders and epoll operations). Owner metadata, README badges and the Node launcher/fallback were untouched. Nothing was pushed.

## CPU-focused server regression round (2026-11-18)

The supplied production results were Go `6258074`: score 941, perf 141, 456780 us; Node `c4a6481`: score 953, perf 153, 391442 us. This round optimizes entry CPU rather than treating local wall time as evidence of a server win. No production regrade of this round was performed.

Before/after below are medians of three `./dock cpu` and three `./dock cpu 1` runs per version. For the baseline repeats, `6258074`'s exact launcher and native binary were temporarily restored, then restored to the new implementation before final validation. CPU is the supplied sampler's sum over both live and replay, sampled every 20 ms in 10 ms CPU ticks; workload p50s come from the live pass. Each column is independently medianed, so component CPU medians need not add to the total median.

| Measurement | 2 CPUs before | 2 CPUs after | 1 CPU before | 1 CPU after |
| --- | ---: | ---: | ---: | ---: |
| Total entry CPU ms | 590 | 430 | 650 | 490 |
| Node launcher CPU ms | 200 | 140 | 220 | 170 |
| Go CPU ms | 390 | 290 | 410 | 310 |
| Push p50 ms | 50.550 | 48.596 | 109.836 | 86.253 |
| Clone p50 ms | 17.460 | 18.203 | 35.093 | 36.403 |
| Read p50 ms | 178.357 | 179.183 | 306.544 | 278.973 |
| Write p50 ms | 23.240 | 22.693 | 25.114 | 31.757 |

Entry CPU fell **27.1% on two CPUs and 24.6% on one CPU**. Total CPU samples were 610/590/570→690/420/430 ms (two CPUs) and 770/580/650→500/430/490 ms (one CPU). Wall-time results remain mixed: the one-CPU clone/write rounds are especially noisy, and one one-CPU run scored perf 199/total 999 while retaining all 120 checks and a matching replay. This is not claimed as a production performance improvement.

Chosen settings: **GOGC=600, GOMAXPROCS=2, no explicit memory limit, raw epoll transport**. Full-grade comparisons inject settings into staged entry source, avoiding the process driver's environment filtering. Before the allocation changes, three-run medians were 370 ms Go CPU for epoll/1 worker/GC100/128 MiB, 310 ms for epoll/2 workers/GC600/unlimited, and 440 ms for the goroutine-per-connection netpoll transport with 2 workers/GC600/unlimited. Netpoll therefore was not retained as the default. Baseline gctrace showed six live collections; final diagnostic runs showed zero, with peak Go RSS **22.74, 23.61, 23.76 MiB**, well below 300 MiB. Reproduce with `test/cpu-variants.ts` and `test/cpu-final-memory.ts` through `./dock node`.

Retained implementation changes:

- Pool zlib compressor state and its scratch buffer as well as the existing inflater state. Packed object bytes remain immutable and cached. Packs and sideband streams now use one final allocation; tests cover compressor reuse, corruption recovery, deltas, and frame boundaries.
- Eliminate cache-key and MIME-string allocations for advertisements, ls-refs and clone responses. Warm handler-plus-complete-HTTP encoding paths for these and issue GETs assert **zero allocations**. Ref and default-branch changes invalidate advertisements and ls-refs while immutable object packs remain reusable.
- Parse HTTP headers directly from bytes, serialize issue creation into reusable scratch with exact JSON escaping, cache the created body, and reuse immutable user metadata. Tests compare serialized bytes to stdlib JSON and check scratch ownership, Unicode, malformed UTF-8 and cross-surface invalidation.
- Replace launcher's fetch initialization with the stdlib HTTP client and a single keep-alive lifecycle socket. Health checking does not retain a socket, every request timer is cleared, and polling remains 250 ms. Fallback application code remains lazy. All seven launcher cases pass; Node used 0 ms measured CPU while Go served 300 requests.

Final `./dock gobuild` and `./dock gotest` passed. `./dock grade 3` passed **120/120 × 3**, score **1000 × 3**, with byte-identical replays: perf_p50_us **42742, 44465, 44637** (mean **43948**). `./dock grade-amd64 3` also passed **120/120 × 3**, score **1000 × 3**, and matched every replay; emulated timings are not used. The retained-log runner verified Go listening with no fallback on all three native and all three forced-amd64-binary trials. The 48-request Node parity comparison and transport/protocol tests also passed. The state hash remains `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`.

Binaries are 6,430,868 bytes amd64 and 6,094,996 bytes arm64. Owner metadata and README badges were untouched. Runtime milestones are `06bfa4b` (GC and compression), `1d312cf` (launcher) and `676aa1e` (hot paths); the final commit records the rebuilt artifacts, benchmark helpers and these measurements.

## Go default and verified runtime (2026-11-18 follow-up)

Go is now the default. `FORGE_SERVER=node` opts out for direct local comparisons. Node imports its fallback application only after a startup failure or explicit opt-out; during normal Go serving it runs only the lifecycle loop. No Go source or binary changed in this follow-up.

The process driver does not pass `FORGE_SERVER` through to the entry. An environment-only selection cannot establish which runtime a grade measured; the earlier decision to keep Node based on noisy wall times is superseded. Use an entry that defaults to Go, or patch the entry itself, and verify the trial stderr. The supplied follow-up CPU measurements were approximately 160–200 ms for the Go child versus 250 ms of Node serving CPU per whole trial (Node total including startup approximately 400–490 ms); these are the user's measurements, not a new measurement here.

With Go as the entry default, `./dock grade 3` passed 120/120 and scored 1000 on every instance, with byte-identical replays. Native perf_p50_us values were **42226, 42728, 42057** (mean **42337**). `./dock grade-amd64 3` also passed 120/120 and scored 1000 on every instance with byte-identical replays; its emulated timings are not performance evidence.

`./dock node test/go-launcher.ts` verifies the default with `FORGE_SERVER` absent and the Node application modules absent, the missing-file and unexecutable-binary fallbacks, invalid/dead ports, startup timeout, and the Node opt-out. Node main used **0 ms CPU at 10 ms tick resolution while Go served 300 requests**. The startup timer is cleared; no new serving timers or polling loops were added.

The helper containers discard successful stderr, so `./dock node test/go-grade-logged.ts` retains separate three-instance runs, asserts the Go listener line and absence of fallback in every trial, and checks all 120 passes plus replay matches. It tests the native binary with the unchanged default entry and the committed amd64 binary through binfmt with only the snapshot's binary selection forced; the latter is separate from the full amd64 Node/container grade above.

## Initial Go port measurements (historical)

The stdlib-only Go 1.24 port in `forge/` implements Git v0/v2, packs and deltas, REST, GraphQL, MCP and the shared deterministic store. Both static Linux binaries are committed. Node was initially retained as default; this decision is superseded above. The launcher copies the selected binary to /tmp, checks startup and health, registers its port, and kills it on exit. Missing, unexecutable, invalid-port, dead-port and five-second timeout cases all fall back to Node. Historical environment-only Go labels below are not proof that Go served a run; use the verified follow-up results above.

The final three-instance comparison (`./dock node test/go-grade-compare.ts`, native arm64, Node 26, two shared CPUs) measured:

| Measurement | Node | Go |
| --- | ---: | ---: |
| Mean perf_p50_us across three instances | 41884.667 | 41842.667 |
| Median instance perf_p50_us | 41761 | 41910 |
| Push p50 ms, median across instances | 51.535 | 50.143 |
| Clone p50 ms, median across instances | 14.549 | 15.246 |
| Read p50 ms, median across instances | 176.253 | 174.763 |
| Write p50 ms, median across instances | 21.741 | 23.149 |

An independent `./dock grade 3` with Go selected measured 42036, 42425 and 43010 us (mean 42490.333). Every Go instance passed 120/120, scored 1000, and replayed byte for byte. `./dock grade-amd64 3` also passed 120/120 on all three instances with matching replays and score 1000 each; emulation timings are not used. All-pass state hash remains `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`. No real-server regrade was performed.

After restoring the Node default, both required three-instance commands were repeated: native timings 42591, 42702 and 42714 us (mean 42669), and 120/120 with matching replays on all native and amd64 instances. Two consecutive final builds at the same source/VCS state matched: amd64 SHA-256 `c4ecf866859885d6f408da0684b3dd965b4e4f4df2738d12fbd95128f571af23`, arm64 `957dd790dd9146a8e08711581fb952407cfbc3e2cbf64023cfdc2419bdfa21d3`.

The warmed direct benchmark (`./dock node test/go-bench.ts`) removes the lifecycle forwarder and shows a larger improvement: median 32533→25374 us for Node→Go, with push/read server CPU approximately 15→5 and 15→10 ms per round. CPU is sampled from /proc in 10 ms ticks and averaged across four rounds; these coarse diagnostics are not full-grade timing. Go uses a single-threaded nonblocking epoll loop, cached complete HTTP responses and immutable Git responses, and pooled zlib inflaters. The net/http and net.Conn alternatives were slower. Tested GOGC 100/200/500, one/two workers, and 64/128/384 MiB soft memory limits; selected one worker, GOGC=100 and 128 MiB. Two workers did not improve full grading.

Validation includes `./dock gotest`, the 48-request Go/Node parity comparison, protocol and transport tests (deltas, checksum/closure rejection, fragments/directives, shared cache invalidation, chunking/trailers, pipelining, half-close, 100-continue and 16 MiB backpressure), and all six initial launcher cases. Binaries are 6,414,484 bytes amd64 and 6,094,996 bytes arm64, each below 8 MiB; the tracked tree is approximately 12.2 MiB, below 16 MiB. README badges and owner metadata were untouched. The initial Go runtime milestone is `9f4cb26`; `52cdb6e` recorded the now-superseded Node default and these initial results.

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
