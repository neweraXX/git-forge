# Forge

A standalone GitHub-compatible forge for `github-core-clone-01`, written in Node 22 TypeScript with the standard library. The server keeps its state in memory, uses no dependencies or Git executable, and makes no model calls.

The four interfaces share one repository and object store:

- Git smart HTTP: protocol v2 discovery, ls-refs, full and shallow fetches, incremental negotiation, and protocol v0 receive-pack with per-ref fast-forward checks, deletes and sideband reports. Pack ingestion verifies SHA-1 checksums and resolves ordinary, reference-delta, offset-delta and thin-pack objects.
- REST v3 under `/api/v3`: repositories, pagination, refs, branches, commits, file contents, labels, issues, comments, pull requests, changed files and squash merges with conflict detection.
- GraphQL at `/api/graphql`: parsed selections, aliases, variables, fragments, directives, introspection, global IDs, cursor connections, batching, and issue/pull/comment mutations.
- MCP at `/mcp`: JSON streamable HTTP, discovery for revision 2026-07-28, legacy initialization, tool schemas, and six tools backed by the same store as REST and GraphQL.

`MAKEFUN_SHOP_TOKEN` is the required bearer credential. `FORGE_LOGIN` can explicitly assign its account; otherwise the first authenticated repository namespace binds that account for this fresh in-memory server. Later foreign namespaces return 404. Stored timestamps use `MAKEFUN_TRIAL_NOW` or a fixed fallback; object IDs and numbering never depend on wall time or randomness.

`main.ts` binds an ephemeral port, registers with `MAKEFUN_ENV_URL`, polls `/done`, and exits only when the suite finishes. The runtime entry imports only its own implementation and Node built-ins. Files under `test/` are development runners; the conformance and benchmark runners import the read-only kit at `/kit` only when explicitly invoked.

From the parent workspace, run checks through the supplied container helper:

```sh
./dock grade
./dock node test/grade-three.ts
./dock node test/conformance.ts
./dock node test/protocol.ts
./dock node test/performance.ts
```

The conformance runner prints every check. The protocol tests additionally exercise incoming delta packs, invalid pack rejection, generic GraphQL parsing, bearer auth and response-cache invalidation across interfaces. The performance runner uses separate server/client processes and prints all workload medians.

The supplied `./dock grade 3` currently passes the scrape-kit flag `--trials`, which this agent kit rejects. `test/grade-three.ts` invokes the same grader with `--instances 3` inside the container. All three practice instances score 1000/1000 and match replay byte for byte; their aggregate timing is 60874 microseconds.

Git metadata and validated object closures are cached because objects are immutable. Fetch responses are bounded and keyed by the complete negotiation request. Issue serialization is cached until a REST or GraphQL mutation or comment changes the issue. Every request still authenticates and reads real shared state.

This implements the contest's GitHub core surface, with an ephemeral single-account store and squash merges. It is MIT licensed. See `SCORING.md` for the scoring analysis and local validation history.
