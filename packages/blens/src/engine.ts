import type { TypeDef, FieldDef, DataFieldDef, LayoutEntry } from './fields';
import type { CompiledCodec, PacketCodec, PacketSchema, ValidateSchema } from './schema';
import { isField, extractFieldsKeys, assertNonNegativeInteger, magic } from './fields';
import { contextualError, toValidationError, validationError } from './errors';
import { isUint8Array } from './bytes/is';

type RuntimePacket = {
  head: Record<string, unknown>;
  body: Uint8Array;
  tail: Record<string, unknown>;
};
type RuntimeCodec = PacketCodec<unknown, RuntimePacket, Readonly<Record<string, FieldDef<unknown>>>>;

export function struct<
  const THead extends readonly LayoutEntry[] = readonly [],
  const TTail extends readonly LayoutEntry[] = readonly [],
  const TSchema extends PacketSchema<THead, TTail> = PacketSchema<THead, TTail>,
>(schema: PacketSchema<THead, TTail> & TSchema
  & ValidateSchema<NoInfer<THead>, NoInfer<TTail>, NoInfer<TSchema>>): CompiledCodec<THead, TTail, TSchema>;
export function struct(schema: PacketSchema): RuntimeCodec {
  if (!Number.isSafeInteger(schema.size) || schema.size < 0) {
    throw new RangeError(`Schema size must be a non-negative safe integer, got ${schema.size}`);
  }
  const packetSize = schema.size;

  const resolvedFields: Record<string, FieldDef<unknown>> = Object.create(null) as Record<string, FieldDef<unknown>>;

  let currentOffset = 0;
  let bodyFieldDef: DataFieldDef | undefined;
  const magicDefs: Array<{ def: FieldDef<number>; value: number }> = [];

  // Length references must point to unsigned integer fields.
  const resolveLengthField = (name: string): FieldDef<number> | undefined => {
    const field = resolvedFields[name];
    if (!field) return undefined;
    if (field.kind !== 'uint') {
      throw new Error(
        `Schema Error: Length field "${name}" must be an unsigned integer (u8/u16.le/…), got a "${field.kind}" field.`,
      );
    }
    return field as FieldDef<number>;
  };

  const compileBlock = (blockName: 'head' | 'tail', block?: readonly LayoutEntry[]) => {
    if (!block) return;

    for (const entry of block) {

      if (isField(entry)) {
        const [name, type] = entry;
        if (typeof (type as Partial<TypeDef<unknown>>)?.at !== 'function') {
          throw new Error(
            `Schema Error: Field "${name}" in "${blockName}" has no codec. `
            + 'Multi-byte integers require explicit endianness: use u16.be / u16.le (u32.be / u32.le).',
          );
        }
        if (Object.hasOwn(resolvedFields, name)) {
          throw new Error(`Schema Error: Duplicate field name "${name}".`);
        }
        assertNonNegativeInteger(type.size, `Field "${name}" size`);
        if (type.kind === 'data' && 'lengthField' in type && type.lengthField !== undefined) {
          throw new Error(`Schema Error: Field "${name}" uses lengthField, which is only supported in body.`);
        }
        resolvedFields[name] = type.at(currentOffset);

        currentOffset += type.size;
      } else if ('magic' in entry) {
        assertNonNegativeInteger(entry.magic.type.size, 'Magic size');
        magic(entry.magic.type, entry.magic.value);
        magicDefs.push({
          def: entry.magic.type.at(currentOffset),
          value: entry.magic.value,
        });
        currentOffset += entry.magic.type.size;
      } else {
        assertNonNegativeInteger(entry.skip, 'Skip size');
        currentOffset += entry.skip;
      }
    }
  };

  compileBlock('head', schema.head);

  if (schema.body) {
    if (schema.body.lengthField && !resolveLengthField(schema.body.lengthField)) {
      throw new Error(
        `Schema Error: Length field "${schema.body.lengthField}" must exist in head before body.`,
      );
    }
    bodyFieldDef = schema.body.at(currentOffset, resolveLengthField);
    currentOffset += bodyFieldDef.size;
  }

  compileBlock('tail', schema.tail);

  if (currentOffset !== schema.size) {
    throw new Error(
      `Schema Error: Compiled layout size ${currentOffset} does not match schema size ${schema.size}. `
      + 'Represent reserved bytes explicitly with skip().',
    );
  }

  let checksumFieldDef: FieldDef<number> | undefined;
  if (schema.checksum) {
    if (schema.body?.lengthField === schema.checksum.field) {
      throw new Error(`Schema Error: Field "${schema.checksum.field}" cannot be both payload length and checksum.`);
    }
    const field = resolvedFields[schema.checksum.field];
    if (!field) {
      throw new Error(`Schema Error: Checksum field "${schema.checksum.field}" not found in layout.`);
    }
    if (field.kind !== 'uint') {
      throw new Error(
        `Schema Error: Checksum field "${schema.checksum.field}" must be an unsigned integer (u8/u16.le/…), got a "${field.kind}" field.`,
      );
    }
    checksumFieldDef = field as FieldDef<number>;
  }

  const headKeys = extractFieldsKeys(schema.head);
  const tailKeys = extractFieldsKeys(schema.tail);
  const checksum = schema.checksum ? { ...schema.checksum } : undefined;
  const isUserField = (name: string) => name !== schema.body?.lengthField && name !== checksum?.field;
  const headInputKeys = headKeys.filter(isUserField);
  const tailInputKeys = tailKeys.filter(isUserField);
  const readonlyResolvedFields = Object.freeze(resolvedFields);
  const checksumPath = checksum
    ? [headKeys.includes(checksum.field) ? 'head' : 'tail', checksum.field]
    : [];

  const calculateChecksum = (buffer: Uint8Array): number => {
    if (!checksum || !checksumFieldDef) throw new Error('Schema Error: Checksum is not configured.');
    const { offset, size } = checksumFieldDef;

    // Copy each time to isolate callback writes, retained buffers and reentrant calls.
    const snapshot = new Uint8Array(buffer);
    snapshot.fill(0, offset, offset + size);
    let value: number;
    try {
      value = checksum.calculate(snapshot, { offset, size });
    } catch (cause) {
      throw contextualError(cause, 'CHECKSUM_FAILED', { path: checksumPath, offset });
    }
    const maxValue = 2 ** (size * 8) - 1;
    if (!Number.isSafeInteger(value) || value < 0 || value > maxValue) {
      throw validationError('INVALID_CHECKSUM', `Checksum must be an integer from 0 to ${maxValue}, got ${value}`, {
        path: checksumPath, offset, actual: value,
      });
    }
    return value;
  };

  function encodeBlock(
    blockName: 'head' | 'tail',
    keys: readonly string[],
    input: Record<string, unknown> | undefined,
    buffer: Uint8Array,
  ) {
    if (keys.length === 0) return;
    if (input === undefined || input === null) {
      throw validationError('MISSING_BLOCK', `Missing "${blockName}" block: expected fields ${keys.map(k => `"${k}"`).join(', ')}.`, {
        path: [blockName],
      });
    }
    for (const key of keys) {
      const def = resolvedFields[key];
      if (!def) continue;
      const val = input[key];
      if (val === undefined) {
        throw validationError('MISSING_FIELD', `Missing value for field "${key}" in "${blockName}".`, {
          path: [blockName, key], offset: def.offset,
        });
      }
      try {
        def.encode(buffer, val);
      } catch (cause) {
        throw contextualError(cause, 'INVALID_FIELD', { path: [blockName, key], offset: def.offset });
      }
    }
  }

  function decodeBlock(blockName: 'head' | 'tail', fields: readonly string[], buffer: Uint8Array): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of fields) {
      const def = resolvedFields[key];
      if (def) {
        let value: unknown;
        try {
          value = def.decode(buffer);
        } catch (cause) {
          throw contextualError(cause, 'INVALID_FIELD', { path: [blockName, key], offset: def.offset });
        }
        // Define an own property without invoking Object.prototype's setter.
        if (key === '__proto__') {
          Object.defineProperty(result, key, {
            value, enumerable: true, writable: true, configurable: true,
          });
        } else {
          result[key] = value;
        }
      }
    }
    return result;
  }

  const codec: RuntimeCodec = {
    get size() {
      return packetSize;
    },
    resolvedFields: readonlyResolvedFields,

    safeEncode(input) {
      try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw validationError('INVALID_INPUT', 'Packet input must be an object');
        }
        const blocks = input as { head?: Record<string, unknown>; body?: Uint8Array; tail?: Record<string, unknown> };
        if (!bodyFieldDef && blocks.body !== undefined
          && (!isUint8Array(blocks.body) || blocks.body.length !== 0)) {
          throw validationError('UNEXPECTED_BODY', 'Schema has no body; only an empty payload is allowed', { path: ['body'] });
        }
        const buffer = new Uint8Array(packetSize);

        // Magic bytes participate in checksum calculation.
        for (const m of magicDefs) {
          m.def.encode(buffer, m.value);
        }

        encodeBlock('head', headInputKeys, blocks.head, buffer);

        if (bodyFieldDef) {
          try {
            bodyFieldDef.encode(buffer, blocks.body === undefined ? new Uint8Array(0) : blocks.body);
          } catch (cause) {
            throw contextualError(cause, 'INVALID_BODY', { path: ['body'], offset: bodyFieldDef.offset });
          }
        }

        encodeBlock('tail', tailInputKeys, blocks.tail, buffer);

        if (checksum && checksumFieldDef) {
          const crcValue = calculateChecksum(buffer);
          checksumFieldDef.encode(buffer, crcValue);
        }

        return { success: true, buffer };
      } catch (e) {
        return { success: false, error: toValidationError(e) };
      }
    },

    safeDecode(buffer) {
      try {
        if (!isUint8Array(buffer)) {
          throw validationError('INVALID_INPUT', 'Packet buffer must be a Uint8Array');
        }
        if (buffer.length !== packetSize) {
          throw validationError('SIZE_MISMATCH', `Buffer size ${buffer.length} does not match schema size ${packetSize}`, {
            expected: packetSize, actual: buffer.length,
          });
        }

        // Check magic first to distinguish a different packet type from corruption.
        for (const m of magicDefs) {
          const got = m.def.decode(buffer);
          if (got !== m.value) {
            throw validationError('MAGIC_MISMATCH',
              `Magic mismatch at offset ${m.def.offset}: expected 0x${m.value.toString(16)}, got 0x${got.toString(16)}`,
              { offset: m.def.offset, expected: m.value, actual: got },
            );
          }
        }

        // Validate checksum before reading a possibly corrupted payload length.
        if (checksum && checksumFieldDef) {
          const expectedCrc = checksumFieldDef.decode(buffer);
          const actualCrc = calculateChecksum(buffer);
          if (expectedCrc !== actualCrc) {
            throw validationError('CHECKSUM_MISMATCH', `CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`, {
              path: checksumPath, offset: checksumFieldDef.offset, expected: expectedCrc, actual: actualCrc,
            });
          }
        }

        const head = decodeBlock('head', headKeys, buffer);

        let body: Uint8Array = new Uint8Array(0);
        if (bodyFieldDef) {
          try {
            body = bodyFieldDef.decode(buffer);
          } catch (cause) {
            throw contextualError(cause, 'INVALID_BODY', { path: ['body'], offset: bodyFieldDef.offset });
          }
        }

        const tail = decodeBlock('tail', tailKeys, buffer);

        return {
          success: true,
          data: { head, body, tail }
        };
      } catch (e) {
        return { success: false, error: toValidationError(e) };
      }
    },

    encode(input) {
      const res = codec.safeEncode(input);
      if (!res.success) throw res.error;
      return res.buffer;
    },

    decode(buffer) {
      const res = codec.safeDecode(buffer);
      if (!res.success) throw res.error;
      return res.data;
    }
  };

  return codec;
}
