// Compile-time regressions for public inference helpers and codec input constraints.
import { data, struct, u8 } from 'blens';
import type {
  EmptyPayload, InferInput, InferOutput, PacketCodec, TypeDef,
} from 'blens';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true : false;
type Expect<T extends true> = T;

const _helperConstraints = () => {
  // @ts-expect-error Input inference requires a callable encoder.
  type InvalidInput = InferInput<{ encode: Uint8Array }>;
  // @ts-expect-error Output inference requires a decoder accepting byte buffers.
  type InvalidOutput = InferOutput<{ decode(value: string): number }>;
};

const _codecUnionsPreserveBothVariants = (chooseNumbers: boolean) => {
  const Numbers = struct({ size: 1, head: [['value', u8]] });
  const Bytes = struct({ size: 1, head: [['value', data({ maxLength: 1 })]] });
  const codec = chooseNumbers ? Numbers : Bytes;

  type Input = InferInput<typeof codec>;
  type Output = InferOutput<typeof codec>;
  type _inputsDistribute = Expect<Equal<Input, InferInput<typeof Numbers> | InferInput<typeof Bytes>>>;
  type _outputsDistribute = Expect<Equal<Output, InferOutput<typeof Numbers> | InferOutput<typeof Bytes>>>;
  type _inputValue = Expect<Equal<Input['head']['value'], number | Uint8Array>>;
  type _outputValue = Expect<Equal<Output['head']['value'], number | Uint8Array>>;
  type _bodyIsEmpty = Expect<Equal<Output['body'], EmptyPayload>>;

  const decoded = codec.decode(new Uint8Array(1));
  type _decodeKeepsUnion = Expect<Equal<typeof decoded, Output>>;
  const result = codec.safeDecode(new Uint8Array(1));
  if (result.success) {
    type _safeDecodeKeepsUnion = Expect<Equal<typeof result.data, Output>>;
    // @ts-expect-error A codec union may decode byte values.
    const value: number = result.data.head.value;
  }

  // @ts-expect-error A numeric input is unsafe until the actual encoder is known.
  codec.encode({ head: { value: 1 } });
};

const _codecInputVariance = (
  typed: PacketCodec<{ value: number }, { value: number }>,
  acceptsAny: PacketCodec<unknown, { value: number }>,
) => {
  const acceptsNumbers: PacketCodec<{ value: number }, { value: number }> = acceptsAny;
  // @ts-expect-error A numeric encoder cannot be used as an encoder of arbitrary input.
  const acceptsUnknown: PacketCodec<unknown, { value: number }> = typed;
  // @ts-expect-error The safe encoder must preserve the same input constraint.
  const safeAcceptsUnknown: Pick<PacketCodec<unknown, unknown>, 'safeEncode'> = typed;
  // @ts-expect-error The throwing encoder must preserve the same input constraint.
  const encodeAcceptsUnknown: Pick<PacketCodec<unknown, unknown>, 'encode'> = typed;

  type _inputSurvivesInterface = Expect<Equal<InferInput<typeof typed>, { value: number }>>;
  type _outputSurvivesInterface = Expect<Equal<InferOutput<typeof typed>, { value: number }>>;
};

const _nonnumericCustomValuesAreNotReferences = (field: TypeDef<{}>) => {
  // @ts-expect-error A broad non-null value type does not establish a numeric length field.
  struct({ size: 2, head: [['length', field]], body: data({ lengthField: 'length', maxLength: 1 }) });
  struct({
    size: 1,
    head: [['crc', field]],
    checksum: {
      // @ts-expect-error A broad non-null value type does not establish a numeric checksum field.
      field: 'crc', calculate: () => 0,
    },
  });
};
