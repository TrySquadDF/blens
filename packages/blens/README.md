# blens

> [!WARNING]
> blens is designed for fixed-size binary structures. If your format has a
> dynamic layout or an unknown total size, this library may not be a good fit.

blens is a small TypeScript library for describing fixed-size binary
structures and converting them to and from `Uint8Array`.

Install the package with `npm install @trysquaddf/blens`.

Define a schema once, then use it to encode and decode messages:

```ts
import * as b from '@trysquaddf/blens';

const Message = b.struct({
  size: 9,
  head: [
    b.magic(b.u8, 0xa5),
    ['type', b.u8],
    ['sequence', b.u16.le],
    ['length', b.u8],
  ],
  body: b.data({ lengthField: 'length', maxLength: 3 }),
  tail: [['checksum', b.u8]],
  checksum: {
    field: 'checksum',
    calculate: (buffer) =>
      buffer.reduce((sum, byte) => (sum + byte) & 0xff, 0),
  },
});

const encoded = Message.encode({
  head: { type: 1, sequence: 42 },
  body: new Uint8Array([10, 20]),
});

const decoded = Message.decode(encoded);

type MessageInput = b.InferInput<typeof Message>;
type MessageOutput = b.InferOutput<typeof Message>;
const packetSize: number = Message.size;
```

blens takes care of field offsets, byte order, payload length, constants and
checksums. Schema creation checks the total layout size, duplicate field names,
field references and the capacity of the payload length field. Encoding and
decoding validate the supplied values and packet bytes.

## Building blocks

- `u8`, `u16.le`, `u16.be`, `u32.le`, `u32.be` define unsigned integers.
- `data()` defines a byte payload.
- `magic()` defines a constant byte or integer.
- `skip()` reserves bytes in the structure.
- `struct()` compiles the schema and returns `encode`, `decode`, `safeEncode`
  and `safeDecode`.

Multi-byte integers always require an explicit byte order. The declared
fields, payload and reserved bytes must add up to the schema's `size`.

`encode` and `decode` throw `PacketValidationError` when validation fails.
Their safe variants return a result object instead.

The compiled codec is a `PacketCodec`. Use `InferInput<typeof Codec>` and
`InferOutput<typeof Codec>` to reuse its encode/decode types without repeating
the schema's layout parameters. `Codec.size` exposes the fixed packet size
as a read-only property.

## Data and validation contracts

- A `data({ maxLength })` factory writes only the supplied payload bytes. When
  writing into a reused buffer, bytes in the remaining capacity are left as
  they were (`[9, 9, 9, 9]` becomes `[1, 9, 9, 9]` for a one-byte payload).
  The unbound `data.write()` method also does not update a configured
  `lengthField`, because it has no resolved field definition. After binding
  with `.at()`, `field.encode()` keeps the same byte-copy behavior and updates
  the resolved length field automatically. `struct.encode()` allocates a new,
  zero-initialized packet, so unused payload capacity is zero in its result.
- `decode` returns independent payload bytes, including when the input is a
  Node/Bun `Buffer` or a view with a nonzero byte offset.
- Byte inputs also accept `Uint8Array` instances from another JavaScript realm,
  such as Node `vm`. Other view types, including `Uint8ClampedArray`,
  `Uint16Array` and `DataView`, are rejected.
- A schema without a body rejects nonempty input payloads. Decode still returns
  an empty `body`, typed as `EmptyPayload` (a `Uint8Array` with length `0`), so
  `Packet.encode(Packet.decode(bytes))` continues to work. For these schemas,
  omit `body` when constructing encode input yourself.
- If the schema type is a union and any variant can contain a body, the
  decoded body is typed as `Uint8Array`. `EmptyPayload` is inferred only when
  no variant declares a body. Encoding still validates the actual schema
  selected at runtime.
- The payload length and configured checksum are computed on encode. Their
  input fields are optional; legacy placeholder values are accepted and ignored.
  Blocks containing only computed fields may be omitted. Decode always includes
  those fields with their actual values.
- Inline schemas infer field names without `as const`. For schemas stored in
  variables, retain literal field names with `as const` or `satisfies`.
  When a checksum/length reference is optional or chosen at runtime, TypeScript
  conservatively requires the potentially user-supplied fields.
- `lengthField` is supported in `body` and must reference a numeric field in
  `head`. Named data fields in `head`/`tail` are fixed-size. Binding a dynamic
  data field directly with `.at()` requires a valid length resolver.
- Literal length references are checked against numeric head fields by
  TypeScript; checksum references are restricted to numeric fields in the
  layout. Widened length names and dynamically assembled layouts also receive
  runtime validation when the schema is created.
- `maxLength` must fit in the referenced length field: up to 255 for `u8`,
  65535 for `u16`, or 4294967295 for `u32`. This is checked at schema creation
  and when binding a data field directly with `.at()`. Actual packet allocation
  remains subject to the runtime's memory and typed-array size limits.
- One field cannot serve as both payload length and checksum. Invalid raw skip
  markers are rejected just like invalid `skip()` calls.
- A compiled codec snapshots its layout and checksum callback. Editing the
  original schema does not reconfigure it; create a new codec instead.
- A checksum callback receives a fresh copy of the packet with its checksum
  bytes zeroed. Mutating or retaining this copy cannot change the packet,
  decoded payload or buffers passed to later callbacks. The callback must be
  synchronous and return an unsigned integer that fits its checksum field.
  Use the supplied
  `{ offset, size }` to exclude checksum bytes when your CRC requires exclusion
  rather than zeroing. Isolation adds one packet-sized allocation and copy per
  checksum calculation. Concurrent writes to shared backing memory remain
  outside this contract.

## Errors

`safeEncode` and `safeDecode` return `{ success: false, error }` on failure.
`encode` and `decode` throw the same `PacketValidationError` instead.
Use `error.details` for programmatic handling; each issue includes a stable
`code` and a human-readable `message`. Field-related issues include a `path`
such as `['head', 'command']` and, where applicable, a byte `offset` relative
to the packet view. Size, magic and checksum mismatches also include
`expected` and `actual` values.

| Code | Meaning |
| --- | --- |
| `INVALID_INPUT` | Encode input is not a packet object, or decode input is not a `Uint8Array` |
| `UNEXPECTED_BODY` | A schema without a body received a nonempty or invalid payload |
| `MISSING_BLOCK`, `MISSING_FIELD` | Required user input is absent |
| `INVALID_FIELD`, `INVALID_BODY` | A field value or payload fails validation |
| `SIZE_MISMATCH`, `MAGIC_MISMATCH`, `CHECKSUM_MISMATCH` | Packet bytes do not match the schema or calculated checksum |
| `CHECKSUM_FAILED` | The checksum callback threw; `cause` contains the original error |
| `INVALID_CHECKSUM` | The callback returned a non-integer, negative or out-of-range checksum |
| `VALIDATION_ERROR` | Fallback for other failures or errors constructed from legacy string messages |

`issues: string[]` and `message` remain available for compatibility. Errors
wrapped from a field codec or callback preserve the original exception in
`cause`. Exact message wording is not a stable API. Invalid schema definitions
still throw `Error` or `RangeError` when calling `struct()` or a field factory,
before a codec is available.

## Scope

blens only describes binary data. It does not depend on a particular
transport, device type or protocol. Reading, writing and framing messages stay
in the surrounding application.

At the moment, schemas are fixed-size. A payload's used length may vary within
its reserved capacity, but the total packet size and field offsets stay fixed.
Nested structures, arrays of typed elements, bitfields and signed integers
are not supported by the built-in API.

The package provides ESM exports. Automated runtime checks cover Bun and Node;
browser execution and compatibility with physical devices are not verified
by the current test suite.

## Development

Run these commands from `packages/blens` after installing workspace dependencies:

```bash
bun run check       # types, all tests, build, Node package integration
bun run test:functionality
bun run test:platform
bun run bench       # Bun throughput benchmarks
bun run bench:node  # the same benchmarks on Node
```

Tests are grouped under `test/functionality` for library behavior and
`test/platform` for runtime and Buffer compatibility.

See [TESTING.md](./TESTING.md) for test coverage and benchmark methodology.

## Releases

Versions and changelogs are managed with Changesets. See
[RELEASING.md](https://github.com/TrySquadDF/blens/blob/main/RELEASING.md) for GitHub Actions and npm publishing setup.

## License

[MIT](./LICENSE).
