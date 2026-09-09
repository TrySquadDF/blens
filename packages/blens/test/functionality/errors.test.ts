import { describe, expect, it } from 'bun:test';
import { PacketValidationError, data, magic, struct, u16, u8 } from '@trysquaddf/blens';

describe('error contract', () => {
  it('returns PacketValidationError from safeEncode for invalid payload size', () => {
    const Packet = struct({
      size: 2,
      body: data({ maxLength: 2 }),
    });

    const result = Packet.safeEncode({
      body: new Uint8Array([1, 2, 3]),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PacketValidationError);
      expect(result.error.name).toBe('PacketValidationError');
      expect(result.error.issues).toEqual(['Data length 3 exceeds max capacity 2']);
      expect(result.error.message).toBe('Data length 3 exceeds max capacity 2');
    }
  });

  it('returns PacketValidationError from safeDecode for invalid buffer size', () => {
    const Packet = struct({
      size: 2,
      head: [['kind', u16.be]] as const,
    });

    const result = Packet.safeDecode(new Uint8Array([0x12]));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PacketValidationError);
      expect(result.error.issues).toEqual(['Buffer size 1 does not match schema size 2']);
    }
  });

  it('throws PacketValidationError from encode and decode wrappers', () => {
    const Packet = struct({
      size: 1,
      body: data({ maxLength: 1 }),
    });

    expect(() =>
      Packet.encode({
        body: new Uint8Array([1, 2]),
      }),
    ).toThrow(PacketValidationError);

    expect(() => Packet.decode(new Uint8Array([1, 2]))).toThrow(PacketValidationError);
  });

  it('preserves the original error as cause in PacketValidationError', () => {
    const boom = new Error('calculate blew up');
    const Packet = struct({
      size: 2,
      head: [['kind', u8]] as const,
      tail: [['crc', u8]] as const,
      checksum: { field: 'crc', calculate: () => { throw boom; } },
    });

    const result = Packet.safeEncode({ head: { kind: 1 }, tail: { crc: 0 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.cause).toBe(boom);
    }
  });
});

describe('structured validation errors', () => {
  const Packet = struct({ size: 1, head: [['command', u8]] });

  it('rejects unexpected payload bytes and preserves decode/encode round trips', () => {
    // @ts-expect-error A schema without a body cannot accept a nonempty payload.
    const result = Packet.safeEncode({ head: { command: 7 }, body: new Uint8Array([9, 8]) });
    if (result.success) throw new Error('Payload was silently discarded');
    expect(result.error.details).toEqual([{
      code: 'UNEXPECTED_BODY', message: result.error.message, path: ['body'],
    }]);
    expect([...Packet.encode(Packet.decode(new Uint8Array([7])))]).toEqual([7]);
    // @ts-expect-error Uint8Array does not have a statically known zero length.
    expect([...Packet.encode({ head: { command: 7 }, body: new Uint8Array(0) })]).toEqual([7]);
  });

  it('reports field paths, offsets and original causes', () => {
    const invalid = Packet.safeEncode({ head: { command: 256 } });
    if (invalid.success) throw new Error('Expected range error');
    expect(invalid.error.details[0]).toMatchObject({ code: 'INVALID_FIELD', path: ['head', 'command'], offset: 0 });
    expect(invalid.error.cause).toBeInstanceOf(RangeError);
    // @ts-expect-error The required command field is missing.
    const missing = Packet.safeEncode({ head: {} });
    if (missing.success) throw new Error('Expected missing field');
    expect(missing.error.details[0]).toMatchObject({ code: 'MISSING_FIELD', path: ['head', 'command'], offset: 0 });
    // @ts-expect-error The required head block is missing.
    const block = Packet.safeEncode({});
    if (block.success) throw new Error('Expected missing block');
    expect(block.error.details[0]).toMatchObject({ code: 'MISSING_BLOCK', path: ['head'] });
  });

  it('distinguishes size, magic, checksum and payload failures without parsing messages', () => {
    const Checked = struct({
      size: 4, head: [magic(u8, 0xa5), ['length', u8]],
      body: data({ lengthField: 'length', maxLength: 1 }), tail: [['crc', u8]],
      checksum: { field: 'crc', calculate: b => b.reduce((sum, value) => (sum + value) & 255, 0) },
    });
    const cases = [
      { bytes: [0], detail: { code: 'SIZE_MISMATCH', expected: 4, actual: 1 } },
      { bytes: [0, 0, 0, 0], detail: { code: 'MAGIC_MISMATCH', offset: 0, expected: 0xa5, actual: 0 } },
      { bytes: [0xa5, 0, 0, 0], detail: { code: 'CHECKSUM_MISMATCH', path: ['tail', 'crc'], offset: 3, expected: 0, actual: 0xa5 } },
      { bytes: [0xa5, 2, 0, 0xa7], detail: { code: 'INVALID_BODY', path: ['body'], offset: 2 } },
    ];
    for (const { bytes, detail } of cases) {
      const result = Checked.safeDecode(new Uint8Array(bytes));
      if (result.success) throw new Error('Expected rejection');
      expect(result.error.details[0]).toMatchObject(detail);
    }
    const overflow = Checked.safeEncode({ body: new Uint8Array(2) });
    if (overflow.success) throw new Error('Expected body overflow');
    expect(overflow.error.details[0]).toMatchObject({ code: 'INVALID_BODY', path: ['body'], offset: 2 });
  });

  it('rejects invalid checksum results consistently on encode and decode', () => {
    for (const value of [-1, 0.5, NaN, Infinity, 256]) {
      const Checked = struct({ size: 1, head: [['crc', u8]], checksum: { field: 'crc', calculate: () => value } });
      for (const result of [Checked.safeEncode({}), Checked.safeDecode(new Uint8Array([0]))]) {
        if (result.success) throw new Error('Expected invalid checksum');
        expect(result.error.details[0]).toMatchObject({ code: 'INVALID_CHECKSUM', path: ['head', 'crc'], offset: 0 });
      }
    }
    const boom = new Error('callback bug');
    const Broken = struct({ size: 1, head: [['crc', u8]], checksum: { field: 'crc', calculate: () => { throw boom; } } });
    const failed = Broken.safeDecode(new Uint8Array([0]));
    if (failed.success) throw new Error('Expected callback failure');
    expect(failed.error.details[0]).toMatchObject({ code: 'CHECKSUM_FAILED', path: ['head', 'crc'], offset: 0 });
    expect(failed.error.cause).toBe(boom);
  });

  it('rejects non-byte decode input and invalid encode input with stable codes', () => {
    // @ts-expect-error Packet bytes must be a Uint8Array.
    const decoded = Packet.safeDecode([7]);
    // @ts-expect-error Encode input must be a packet object.
    const encoded = Packet.safeEncode(null);
    for (const result of [decoded, encoded]) {
      if (result.success) throw new Error('Expected invalid input');
      expect(result.error.details[0]?.code).toBe('INVALID_INPUT');
    }
  });

  it('keeps legacy messages and gives them a fallback code', () => {
    const original = new Error('original');
    const error = new PacketValidationError(['first', 'second'], { cause: original });
    expect(error.issues).toEqual(['first', 'second']);
    expect(error.message).toBe('first; second');
    expect(error.details.map(issue => issue.code)).toEqual(['VALIDATION_ERROR', 'VALIDATION_ERROR']);
    expect(error.cause).toBe(original);
  });
});
