/** Compile-time assertions and expected errors. This file is not executed by the test runner. */
import { struct, u8, u16, u32, data, magic, skip } from '@trysquaddf/blens';
import type { FieldDef, InferInput, InferOutput, PacketCodec } from '@trysquaddf/blens';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

const makePacket = () => struct({
  size: 5,
  head: [
    ['cmd', u8],
    ['value', u16.le],
  ] as const,
  tail: [
    ['seq', u8],
    ['crc', u8],
  ] as const,
  checksum: { field: 'crc', calculate: () => 0 },
});

// Compiled codec inference.
const Packet = makePacket();
type Input = InferInput<typeof Packet>;
type Output = InferOutput<typeof Packet>;

type _codecHasSize = Expect<Equal<typeof Packet.size, number>>;
type _codecIsExplicit = Expect<Equal<typeof Packet, PacketCodec<Input, Output, typeof Packet.resolvedFields>>>;

type Decoded = Output;

type _headIsTyped = Expect<Equal<Decoded['head'], { cmd: number; value: number }>>;
type _bodyIsEmpty = Expect<Equal<Decoded['body'], import('@trysquaddf/blens').EmptyPayload>>;
type _tailIsTyped = Expect<Equal<Decoded['tail'], { seq: number; crc: number }>>;

const _inferredInputWorks = (input: Input) => Packet.encode(input);

// Resolved field names and value types.
type Fields = ReturnType<typeof makePacket>['resolvedFields'];

type _fieldDefIsTyped = Expect<Equal<Fields['cmd'], FieldDef<number>>>;
const _unknownFieldIsError = () => {
  const P = makePacket();
  // @ts-expect-error 'nope' is not a field of this schema.
  return P.resolvedFields.nope;
};

// Optional body and empty input blocks.
const _bodyIsOptional = () =>
  makePacket().encode({ head: { cmd: 1, value: 2 }, tail: { seq: 0, crc: 0 } });

const _emptyBlocksAreOptional = () => {
  const P = struct({ size: 2, body: data({ maxLength: 2 }) });
  return P.encode({ body: new Uint8Array([1, 2]) });
};

// Required encode fields.
const _missingHeadFieldIsError = () =>
  // @ts-expect-error Property 'value' is missing in head.
  makePacket().encode({ head: { cmd: 1 }, tail: { seq: 0, crc: 0 } });

// Explicit byte order for multi-byte integers.
const _bareU16IsError = () => struct({
  size: 2,
  // @ts-expect-error Bare u16 has no codec - use u16.be / u16.le.
  head: [['x', u16]] as const,
});

const _bareU32IsError = () => struct({
  size: 4,
  // @ts-expect-error Bare u32 has no codec - use u32.be / u32.le.
  head: [['x', u32]] as const,
});

// Checksum field references.
const _checksumTypoIsError = () => struct({
  size: 2,
  head: [['kind', u8], ['crc', u8]] as const,
  checksum: {
    // @ts-expect-error 'crk' is not a field of this schema.
    field: 'crk',
    calculate: () => 0,
  },
});

// Magic constants are omitted from input and output.
const makeMagicPacket = () => struct({
  size: 5,
  head: [
    magic(u8, 0xa5),
    ['cmd', u8],
  ] as const,
  tail: [
    magic(u16.be, 0x0d0a),
    ['crc', u8],
  ] as const,
});

type MagicDecoded = ReturnType<ReturnType<typeof makeMagicPacket>['decode']>;
type _magicNotInHead = Expect<Equal<MagicDecoded['head'], { cmd: number }>>;
type _magicNotInTail = Expect<Equal<MagicDecoded['tail'], { crc: number }>>;

const _magicNotRequiredInInput = () =>
  makeMagicPacket().encode({ head: { cmd: 1 }, tail: { crc: 0 } });

// A block containing only constants is optional on encode.
const _magicOnlyBlockIsOptional = () => {
  const P = struct({ size: 2, head: [magic(u16.be, 0xbeef)] as const });
  return P.encode({});
};

const _bareU16MagicIsError = () =>
  // @ts-expect-error Bare u16 has no codec - use u16.be / u16.le.
  magic(u16, 0xffff);

const _dataMagicIsError = () =>
  // @ts-expect-error Magic requires an unsigned integer type.
  magic(data({ maxLength: 2 }), 0);

// Duplicate field names.
const _duplicateInHeadIsError = () =>
  // @ts-expect-error Duplicate field names in "head".
  struct({ size: 2, head: [['a', u8], ['a', u8]] as const });

const _duplicateAcrossBlocksIsError = () =>
  // @ts-expect-error Duplicate field names across "head" and "tail".
  struct({ size: 2, head: [['a', u8]] as const, tail: [['a', u8]] as const });

// Inline inference and skips must not introduce a string index signature.
const _inlineAndSkipTypes = () => {
  const P = struct({ size: 4, head: [['cmd', u8], skip(1)], tail: [['value', u16.le]] });
  const decoded = P.decode(new Uint8Array(4));
  type _headKeys = Expect<Equal<keyof typeof decoded.head, 'cmd'>>;
  type _headValue = Expect<Equal<typeof decoded.head.cmd, number>>;
  type _resolvedKeys = Expect<Equal<keyof typeof P.resolvedFields, 'cmd' | 'value'>>;
  P.encode({ head: { cmd: 1 }, tail: { value: 2 } });
  // @ts-expect-error Typo in a block containing skip.
  decoded.head.typo;
  // @ts-expect-error Typo in resolved fields with skip.
  P.resolvedFields.typo;
  // @ts-expect-error Required head block, even without as const.
  P.encode({ tail: { value: 2 } });
  // @ts-expect-error Values retain their numeric type.
  P.encode({ head: { cmd: '1' }, tail: { value: 2 } });
};

const _skipOnlyAndEmptyBlocks = () => {
  const P = struct({ size: 2, head: [skip(2)] });
  P.encode({});
  // @ts-expect-error No resolved field is declared.
  P.resolvedFields.typo;
  // @ts-expect-error No head field is declared.
  P.decode(new Uint8Array(2)).head.typo;
  const Empty = struct({ size: 0 });
  Empty.encode({});
  // @ts-expect-error Empty schemas expose no fields.
  Empty.resolvedFields.typo;
};

const _duplicatesAroundSkip = () => {
  // @ts-expect-error Skip does not hide duplicate names.
  struct({ size: 3, head: [['x', u8], skip(1), ['x', u8]] });
  // @ts-expect-error Cross-block duplicates are rejected without as const.
  struct({ size: 2, head: [['x', u8]], tail: [['x', u8]] });
};

const _dynamicArrayKeepsDeclaredTypes = () => {
  const head: Array<readonly ['value', typeof u8]> = [['value', u8]];
  const P = struct({ size: 1, head });
  P.encode({ head: { value: 1 } });
  // @ts-expect-error An array with known field names still requires its block.
  P.encode({});
  // @ts-expect-error Array element types are retained.
  P.encode({ head: { value: '1' } });
};

const _computedInputs = () => {
  const P = struct({
    size: 5, head: [['cmd', u8], ['length', u8]],
    body: data({ lengthField: 'length', maxLength: 2 }),
    tail: [['crc', u8]], checksum: { field: 'crc', calculate: () => 0 },
  });
  P.encode({ head: { cmd: 1 }, body: new Uint8Array([2]) });
  P.encode({ head: { cmd: 1, length: 0 }, tail: { crc: 0 } });
  // @ts-expect-error Computed length does not make cmd optional.
  P.encode({});
  // @ts-expect-error Computed placeholders keep their value types.
  P.encode({ head: { cmd: 1 }, tail: { crc: '0' } });
  const decoded = P.decode(new Uint8Array(5));
  type _lengthIsPresent = Expect<Equal<typeof decoded.head.length, number>>;
  type _checksumIsPresent = Expect<Equal<typeof decoded.tail.crc, number>>;

  const OnlyComputed = struct({
    size: 3, head: [['length', u8]], body: data({ lengthField: 'length', maxLength: 1 }),
    tail: [['crc', u8]], checksum: { field: 'crc', calculate: () => 0 },
  });
  OnlyComputed.encode({ body: new Uint8Array([7]) });
  OnlyComputed.encode({});
};

const _optionalConfigDoesNotRelaxInput = (enabled: boolean) => {
  const P = struct({
    size: 1, head: [['crc', u8]],
    ...(enabled ? { checksum: { field: 'crc' as const, calculate: () => 0 } } : {}),
  });
  // @ts-expect-error Crc is required when checksum might be absent.
  P.encode({});
  P.encode({ head: { crc: 1 } });

  const Dynamic = struct({
    size: 2, head: [['length', u8]],
    body: data({ maxLength: 1, ...(enabled ? { lengthField: 'length' } : {}) }),
  });
  // @ts-expect-error Length is required when lengthField might be absent.
  Dynamic.encode({});
};

const _runtimeChoiceDoesNotMakeBothFieldsOptional = (chooseA: boolean) => {
  const field = chooseA ? 'a' : 'b';
  const P = struct({
    size: 2, head: [['a', u8], ['b', u8]],
    checksum: { field, calculate: () => 0 },
  });
  P.encode({ head: { a: 1, b: 2 } });
  // @ts-expect-error Exactly one field is computed, so neither can be omitted statically.
  P.encode({});
  // @ts-expect-error B might be a user field.
  P.encode({ head: { a: 1 } });
};

const _dynamicLayoutsUseRuntimeDuplicateChecks = () => {
  const head: import('@trysquaddf/blens').LayoutEntry[] = [['a', u8]];
  const tail: import('@trysquaddf/blens').LayoutEntry[] = [['b', u8]];
  // Both arrays may contain any name; that alone is not proof of a duplicate.
  const P = struct({ size: 2, head, tail });
  P.encode({ head: { a: 1 }, tail: { b: 2 } });
};

const _bodyMustMatchSchema = () => {
  const P = struct({ size: 1, head: [['command', u8]] });
  // @ts-expect-error Schemas without a body cannot accept arbitrary payload bytes.
  P.encode({ head: { command: 7 }, body: new Uint8Array([9]) });
  const input = { head: { command: 7 }, body: new Uint8Array([9]) };
  // @ts-expect-error Also rejects payloads in variables, not just object literals.
  P.safeEncode(input);
  const decoded = P.decode(new Uint8Array([7]));
  type _emptyLength = Expect<Equal<typeof decoded.body.length, 0>>;
  P.encode(decoded);
  P.safeEncode(decoded);
  const WithBody = struct({ size: 1, body: data({ maxLength: 1 }) });
  type _bodyRemainsBytes = Expect<Equal<ReturnType<typeof WithBody.decode>['body'], Uint8Array>>;
  WithBody.encode({ body: new Uint8Array([9]) });
};

type BodyVariant = { size: number; body: import('@trysquaddf/blens').DataFieldFactory };
type ReservedVariant = { size: number; head: readonly [import('@trysquaddf/blens').SkipEntry] };

const _bodyAcrossSchemaVariants = (schema: BodyVariant | ReservedVariant) => {
  const P = struct(schema);
  const decoded = P.decode(new Uint8Array([7]));
  type _bodyCanContainBytes = Expect<Equal<typeof decoded.body, Uint8Array>>;
  // @ts-expect-error One variant contains a body, so its length is not always zero.
  const length: 0 = decoded.body.length;
  P.encode({ body: new Uint8Array([7]) });
  P.safeEncode({ body: new Uint8Array([7]) });
  const result = P.safeDecode(new Uint8Array([7]));
  if (result.success) {
    type _safeBodyCanContainBytes = Expect<Equal<typeof result.data.body, Uint8Array>>;
    // @ts-expect-error The safe decoder must not promise an empty body either.
    const safeLength: 0 = result.data.body.length;
  }
};

const _bodyAbsentAcrossAllVariants = (schema: ReservedVariant | { size: number; tail: readonly [import('@trysquaddf/blens').SkipEntry] }) => {
  const P = struct(schema);
  type _bodyIsEmpty = Expect<Equal<ReturnType<typeof P.decode>['body'], import('@trysquaddf/blens').EmptyPayload>>;
  // @ts-expect-error No variant accepts nonempty payload bytes.
  P.encode({ body: new Uint8Array([7]) });
  P.encode(P.decode(new Uint8Array([7])));
};

const _optionalBodyAcrossVariants = (schema: { size: number; body?: import('@trysquaddf/blens').DataFieldFactory } | ReservedVariant) => {
  const P = struct(schema);
  type _possibleBodyIsBytes = Expect<Equal<ReturnType<typeof P.decode>['body'], Uint8Array>>;
  P.encode({ body: new Uint8Array([7]) });
};

const _numericReferences = (enabled: boolean, name: string) => {
  // @ts-expect-error A length field must be in head, not tail.
  struct({ size: 2, body: data({ lengthField: 'length', maxLength: 1 }), tail: [['length', u8]] });
  // @ts-expect-error An unknown literal length field is rejected without as const.
  struct({ size: 2, head: [['length', u8]], body: data({ lengthField: 'typo', maxLength: 1 }) });
  const optional = data({ maxLength: 1, ...(enabled ? { lengthField: 'typo' } : {}) });
  // @ts-expect-error A possibly configured literal name must also be valid.
  struct({ size: 2, head: [['length', u8]], body: optional });
  struct({ size: 2, head: [['length', u8]], body: data({ lengthField: name, maxLength: 1 }) });
  struct({ size: 2, head: [['length', u8]], body: data({ maxLength: 1, ...(enabled ? { lengthField: 'length' } : {}) }) });
  struct({
    size: 2, head: [['bytes', data({ maxLength: 1 })], ['crc', u8]],
    checksum: {
      // @ts-expect-error Existing byte fields are not numeric checksum fields.
      field: 'bytes', calculate: () => 0,
    },
  });
};
