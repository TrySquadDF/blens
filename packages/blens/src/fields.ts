import { BYTE_MASK, BITS_IN_BYTE } from './bytes/consts';
import { isUint8Array } from './bytes/is';

/** Identifies fields that can store lengths and checksums. */
export type FieldKind = 'uint' | 'data';

export interface FieldDef<TType> {
  readonly kind: FieldKind;
  readonly offset: number;
  readonly size: number;
  encode(buffer: Uint8Array, value: TType): void;
  decode(buffer: Uint8Array): TType;
}

export interface TypeDef<TType> {
  readonly kind: FieldKind;
  readonly size: number;
  write(buffer: Uint8Array, offset: number, value: TType): void;
  read(buffer: Uint8Array, offset: number): TType;
  at(offset: number): FieldDef<TType>;
}

export interface DataFieldDef extends FieldDef<Uint8Array> {
  readonly maxLength: number;

  /**
   * Copies the payload bytes and, when `lengthField` was configured on the
   * factory, writes the payload length to the resolved length field.
   * Remaining capacity bytes are not cleared.
   */
  encode(buffer: Uint8Array, value: Uint8Array): void;
}

/** Multi-byte integers require an explicit byte order. */
export interface EndianTypeDef<TType> {
  readonly be: TypeDef<TType>;
  readonly le: TypeDef<TType>;
}

export interface DataFieldFactory extends TypeDef<Uint8Array> {
  readonly lengthField?: string;
  readonly maxLength: number;

  /**
   * Copies only the payload bytes into the fixed-capacity field region.
   * Bytes after `value.length` are left untouched, so callers reusing a
   * buffer must clear that region themselves when stale bytes are unsafe.
   * This unbound factory method cannot update `lengthField`; use `.at()` to
   * bind the field and call its `encode()` method for automatic length writes.
   */
  write(buffer: Uint8Array, offset: number, value: Uint8Array): void;

  /**
   * Binds the field to an offset. The bound `encode()` method has the same
   * payload-copy semantics and also updates the resolved `lengthField`, when
   * configured.
   */
  at(offset: number, resolveLengthField?: (name: string) => FieldDef<number> | undefined): DataFieldDef;
}

/** An unnamed constant written on encode and validated on decode. */
export interface MagicEntry {
  readonly magic: {
    readonly type: TypeDef<number>;
    readonly value: number;
  };
}

export interface SkipEntry {
  readonly skip: number;
}

export type LayoutEntry = readonly [name: string, type: TypeDef<unknown>] | SkipEntry | MagicEntry;

export type BitwiseIntSize = 1 | 2 | 4;

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

function assertBufferRange(buffer: Uint8Array, offset: number, size: number): void {
  assertNonNegativeInteger(offset, 'Offset');

  if (offset + size > buffer.length) {
    throw new RangeError(
      `Field range [${offset}, ${offset + size}) exceeds buffer length ${buffer.length}`,
    );
  }
}

function createType<TType>(
  kind: FieldKind,
  size: number,
  writer: (buf: Uint8Array, offset: number, value: TType) => void,
  reader: (buf: Uint8Array, offset: number) => TType
): TypeDef<TType> {
  return {
    kind,
    size,
    write: (buffer, offset, value) => {
      assertBufferRange(buffer, offset, size);
      writer(buffer, offset, value);
    },
    read: (buffer, offset) => {
      assertBufferRange(buffer, offset, size);
      return reader(buffer, offset);
    },
    at: (offset) => {
      assertNonNegativeInteger(offset, 'Offset');

      return Object.freeze({
        kind,
        offset,
        size,
        encode: (buffer: Uint8Array, value: TType) => {
          assertBufferRange(buffer, offset, size);
          writer(buffer, offset, value);
        },
        decode: (buffer: Uint8Array) => {
          assertBufferRange(buffer, offset, size);
          return reader(buffer, offset);
        },
      });
    },
  };
}

function createUintType(size: BitwiseIntSize, isBE: boolean): TypeDef<number> {
  const maxValue = 2 ** (size * BITS_IN_BYTE) - 1;

  // For u16, byte shifts run from 8 to 0 in BE and from 0 to 8 in LE.
  const startShift = isBE ? (size - 1) * BITS_IN_BYTE : 0;
  const step = isBE ? -BITS_IN_BYTE : BITS_IN_BYTE;

  return createType<number>(
    'uint',
    size,
    (buf, off, val) => {
      if (!Number.isSafeInteger(val) || val < 0 || val > maxValue) {
        throw new RangeError(
          `Unsigned ${size * BITS_IN_BYTE}-bit value must be an integer from 0 to ${maxValue}, got ${val}`,
        );
      }

      let shift = startShift;
      for (let i = 0; i < size; i++) {
        buf[off + i] = (val >>> shift) & BYTE_MASK;
        shift += step;
      }
    },

    (buf, off) => {
      let val = 0;
      let shift = startShift;
      for (let i = 0; i < size; i++) {
        val |= (buf[off + i] ?? 0) << shift;
        shift += step;
      }
      return val >>> 0;
    }
  );
}

function createEndianPair(size: BitwiseIntSize): EndianTypeDef<number> {
  return Object.freeze({
    be: createUintType(size, true),
    le: createUintType(size, false),
  });
}

/**
 * Creates a fixed-capacity byte field.
 *
 * The factory-level `write()` method copies only the supplied payload bytes;
 * it does not clear the rest of a reused destination and cannot update a
 * `lengthField` by name. Bind the factory with `.at()` when the length field
 * should be resolved and maintained by `encode()`.
 */
export function data<const TLengthField extends string>(opts: { lengthField: TLengthField; maxLength: number }):
  DataFieldFactory & { readonly lengthField: TLengthField };
export function data<const TLengthField extends string>(opts: { lengthField?: TLengthField; maxLength: number }):
  DataFieldFactory & { readonly lengthField?: TLengthField };
export function data(opts: { lengthField?: string; maxLength: number }): DataFieldFactory {
  const maxLength = opts.maxLength;
  const lengthField = opts.lengthField;

  assertNonNegativeInteger(maxLength, 'Data maxLength');
  if (lengthField !== undefined && lengthField.length === 0) {
    throw new Error('Data lengthField must not be empty');
  }

  const write: (buf: Uint8Array, offset: number, val: Uint8Array) => void = (buf, offset, val) => {
    assertBufferRange(buf, offset, maxLength);
    if (!isUint8Array(val)) {
      throw new TypeError(`Data field expects a Uint8Array payload, got ${typeof val}`);
    }
    if (val.length > maxLength) {
      throw new Error(`Data length ${val.length} exceeds max capacity ${maxLength}`);
    }
    buf.set(val, offset);
  };

  const read: (buf: Uint8Array, offset: number) => Uint8Array = (buf, offset) => {
    assertBufferRange(buf, offset, maxLength);
    return new Uint8Array(buf.subarray(offset, offset + maxLength));
  };

  return {
    kind: 'data',
    size: maxLength,
    // Omit absent options for exactOptionalPropertyTypes.
    ...(lengthField !== undefined ? { lengthField } : {}),
    maxLength,
    write,
    read,

    at: (offset, resolveLengthField) => {
      assertNonNegativeInteger(offset, 'Offset');
      const lenField = lengthField === undefined ? undefined : resolveLengthField?.(lengthField);
      if (lengthField !== undefined && !lenField) {
        throw new Error(`Length field "${lengthField}" requires a resolver and an existing unsigned integer field`);
      }
      if (lenField && lenField.kind !== 'uint') {
        throw new Error(`Length field "${lengthField}" must be an unsigned integer`);
      }
      if (lenField && maxLength > 2 ** (lenField.size * BITS_IN_BYTE) - 1) {
        throw new RangeError(
          `Data maxLength ${maxLength} exceeds length field "${lengthField}" capacity ${2 ** (lenField.size * BITS_IN_BYTE) - 1}`,
        );
      }

      return Object.freeze({
        kind: 'data' as const,
        offset,
        size: maxLength,
        maxLength,
        encode: (buf: Uint8Array, val: Uint8Array) => {
          write(buf, offset, val);
          if (lenField) {
            lenField.encode(buf, val.length);
          }
        },
        decode: (buf: Uint8Array) => {
          assertBufferRange(buf, offset, maxLength);
          if (lenField) {
            const len = lenField.decode(buf);
            if (!Number.isSafeInteger(len) || len < 0 || len > maxLength) {
              throw new RangeError(
                `Data length ${len} from field "${lengthField}" exceeds max capacity ${maxLength}`,
              );
            }
            return new Uint8Array(buf.subarray(offset, offset + len));
          }

          return read(buf, offset);
        }
      });
    },
  };
}

export const skip = (bytes: number): SkipEntry => {
  assertNonNegativeInteger(bytes, 'Skip size');
  return Object.freeze({ skip: bytes });
};

export const magic = (type: TypeDef<number>, value: number): MagicEntry => {
  if (typeof (type as Partial<TypeDef<number>>)?.at !== 'function') {
    throw new Error(
      'Magic type has no codec. '
      + 'Multi-byte integers require explicit endianness: use u16.be / u16.le (u32.be / u32.le).',
    );
  }
  if (type.kind !== 'uint') {
    throw new Error(`Magic value must use an unsigned integer type (u8/u16.le/…), got a "${type.kind}" type.`);
  }
  // Validate the constant when the schema is declared.
  type.write(new Uint8Array(type.size), 0, value);
  return Object.freeze({ magic: Object.freeze({ type, value }) });
};

export const isField = (e: LayoutEntry): e is readonly [string, TypeDef<unknown>] => Array.isArray(e);
export const extractFieldsKeys = (fields: readonly LayoutEntry[] | undefined) => fields?.filter(isField).map(e => e[0]) ?? [];

// Byte-order aliases let generated layouts treat all integers uniformly.
const u8Type = createUintType(1, true);
export const u8: TypeDef<number> & EndianTypeDef<number> = Object.freeze({
  ...u8Type,
  be: u8Type,
  le: u8Type,
});

export const u16: EndianTypeDef<number> = createEndianPair(2);
export const u32: EndianTypeDef<number> = createEndianPair(4);
