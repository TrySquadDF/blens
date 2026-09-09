# Verification

Run `bun run check` after installing workspace dependencies. It checks types
(including negative compile-time cases and benchmarks), runs Bun tests, builds
package exports and exercises the built package on Node.

Coverage percentages are diagnostic, not an acceptance criterion. A regression
must fail for the relevant bad behavior, not just execute the changed line.

| Contract | Evidence |
| --- | --- |
| Wire compatibility | Fixed byte fixtures in `functionality/uint.test.ts` and `functionality/codec.test.ts`; boundary and seeded random integers compared against DataView in `functionality/property.test.ts` |
| Memory ownership | `platform/buffer.test.ts`: Buffer and Uint8Array subviews; repeated decoding, unsigned checksum widths/endian variants, exceptions, mutating/retained checksum snapshots and payload mutation in both directions |
| Corruption detection | Exhaustive single-byte substitutions in two wire fixtures; validation order; CRC-16/CCITT-FALSE check vector with excluded checksum bytes in the middle |
| Schema safety | `functionality/schema.test.ts`: raw negative/fractional skips, conflicting references, length-field capacity boundaries, dynamic data in unsupported blocks, mutation of the source schema |
| Input contracts | Missing user values and unexpected body bytes fail; computed placeholders may be omitted; empty/short/full payloads and overflow; decoded empty bodies can be re-encoded |
| Error contracts | `functionality/errors.test.ts`: stable issue codes, paths, offsets, mismatch values, original causes and legacy string messages |
| Static guarantees | `functionality/types.check.ts`: literal names, numeric references, skips, duplicate names, required user fields, schema-specific body inputs including unions with optional bodies, computed fields, dynamic arrays and optional/runtime-selected references |
| Runtime/package compatibility | `platform/node.mjs` imports the built package through its exports and checks Node Buffer, cross-realm Uint8Array packet views/payloads from Node vm, and rejection of other views and spoofed type tags |

Packet round trips remain useful for normalization, but do not replace wire
fixtures: matching bugs in encode and decode could otherwise cancel out.
The additive checksum corruption test establishes single-byte detection for its
fixtures; it does not claim collision resistance or multi-byte error detection.
No hardware packet captures are included, so these tests do not establish
compatibility with a particular physical device.

# Performance

`bun run bench` and `bun run bench:node` run the same cases:

- 10, 64, 512 and 4096 bytes, with no checksum, sum16 and CRC16;
- deterministic rotating inputs with empty, partial and full payloads;
- encode/decode, 64-byte round trips and Node-compatible Buffer views;
- separate size, magic and checksum rejection paths;
- uint primitives versus a reused DataView, and schema setup.

Fixtures are checked before timing. Operations return values derived from the
actual decoded fields/payload or encoded bytes. The aggregate is printed.
Warmup and calibration are outside measurements; batch sizes increase until a
calibration batch lasts about 10 ms. Results report median and p25..p75 across
21 batches. These are throughput samples, not individual packet latency or GC
pause percentiles. The DataView diagnostic has different value-validation
semantics; it is not a drop-in replacement comparison.

Checksum cases include the packet copy used to isolate callback writes. Each
checksum calculation allocates its own snapshot, including on rejection paths.

For a focused comparison:

```sh
BLENS_BENCH_FILTER='64B sum16' bun run bench
BLENS_BENCH_JSON=/tmp/blens-bench.json bun run bench:node
```

Compare the same harness/corpus on the same machine and runtime in separate
processes, and repeat if the spread overlaps the claimed improvement. Avoid
running competing benchmarks concurrently. The benchmark includes its result
consumption overhead and excludes transport, device latency and UI work.
