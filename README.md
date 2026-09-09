<p align="center">
  <img src="./assets/logotype/blens.svg" alt="blens logo" width="112" height="109" />
</p>

<h1 align="center">blens</h1>

<p align="center">
  Typed structures from binary data.
  <br />
  Define a schema. Read the bytes. Write them back.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/blens"><img src="https://img.shields.io/npm/v/blens?style=flat-square" alt="Latest npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/TrySquadDF/blens?style=flat-square" alt="License" /></a>
  <a href="https://github.com/TrySquadDF/blens/actions/workflows/ci.yml"><img src="https://github.com/TrySquadDF/blens/actions/workflows/ci.yml/badge.svg" alt="CI: types, tests and package checks" /></a>
</p>

<p align="center">
  <a href="./packages/blens/README.md">Documentation</a> ·
  <a href="./packages/blens/EXAMPLE.md">Example</a> ·
  <a href="./packages/blens/CHANGELOG.md">Changelog</a>
</p>

## What is blens?

blens is a TypeScript library for describing fixed-size binary structures and
converting them to and from `Uint8Array`. A schema defines how bytes map to
named fields, with inferred TypeScript types for encoding and decoding.

- **Typed fields** — unsigned integers, byte payloads, constants and reserved bytes.
- **Explicit byte order** — little-endian and big-endian integer codecs.
- **Automatic bookkeeping** — field offsets, payload lengths and checksums.
- **Validation** — schema checks and structured errors, with throwing and safe APIs.

The library works independently of any transport, device or protocol.

## Motivation

blens was created as a simple DSL for turning byte arrays into typed structures
and back. Describe the fields and their byte order once, then use the same
schema to decode incoming bytes and encode outgoing data.

The goal is to keep this conversion easy to read and maintain, with field
offsets, payload lengths and checksums handled by the library.

## Installation

```sh
npm install blens
```

Or with Bun:

```sh
bun add blens
```

## Quick start

Describe a four-byte message: a constant marker, a command and a 16-bit value.

```ts
import * as b from 'blens';

const Message = b.struct({
  size: 4,
  head: [
    b.magic(b.u8, 0xa5),
    ['command', b.u8],
    ['value', b.u16.le],
  ],
});

// Read named fields from bytes.
const bytes = new Uint8Array([0xa5, 0x01, 0x2a, 0x00]);
const message = Message.decode(bytes);

console.log(message.head); // { command: 1, value: 42 }

// Write the same structure back to bytes.
const encoded = Message.encode({
  head: { command: 1, value: 42 },
});
// Uint8Array [165, 1, 42, 0]

type MessageInput = b.InferInput<typeof Message>;
type MessageOutput = b.InferOutput<typeof Message>;
```

Use `safeEncode` and `safeDecode` to handle validation failures as result objects.
See the [package documentation](./packages/blens/README.md) for payloads,
automatic length fields, checksums and error details.

## Scope

Layouts have a fixed total size and fixed field offsets. A payload can use fewer
bytes than its reserved capacity, but the overall packet size stays the same.
The built-in API currently supports unsigned 8-, 16- and 32-bit integers;
nested structures, typed arrays of elements, bitfields and signed integers
are not supported.

Reading from a transport and splitting incoming data into packets belong in
the surrounding application.

## Development

From the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run test:package
```

`check` validates types, runs the Bun test suite, builds the package and runs
Node integration tests. `test:package` installs the npm archive in a clean
temporary project and runs the Node integration tests against that installation.
GitHub Actions runs these checks on Node 22, 24 and 26.

See [TESTING.md](./packages/blens/TESTING.md) for test coverage and benchmarks.

## Releases

Add a release note with `bun run changeset` when a change should reach npm.
Changesets prepares the version and changelog in a release pull request;
merging it into `main` triggers automatic publication through GitHub Actions.

See [RELEASING.md](./RELEASING.md) for the initial npm setup and release workflow.

## License

[MIT](./LICENSE) © blens contributors.
