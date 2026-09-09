import { describe, expect, it } from 'bun:test';
import { data, magic, struct, u16, u8 } from 'blens';

const bytes = (buffer: Uint8Array) => Array.from(buffer);

describe('magic constants', () => {
  it('encode writes the constant without requiring it in the input', () => {
    const Packet = struct({
      size: 2,
      head: [
        magic(u8, 0xa5),
        ['cmd', u8],
      ] as const,
    });

    const encoded = Packet.encode({ head: { cmd: 7 } });
    expect(bytes(encoded)).toEqual([0xa5, 7]);
  });

  it('decode accepts a matching constant and omits it from the result', () => {
    const Packet = struct({
      size: 2,
      head: [
        magic(u8, 0xa5),
        ['cmd', u8],
      ] as const,
    });

    const decoded = Packet.decode(new Uint8Array([0xa5, 0x42]));
    expect(decoded.head).toEqual({ cmd: 0x42 });
  });

  it('decode rejects a wrong constant with offset and both values in the message', () => {
    const Packet = struct({
      size: 2,
      head: [
        ['cmd', u8],
        magic(u8, 0xa5),
      ] as const,
    });

    const result = Packet.safeDecode(new Uint8Array([0x01, 0x5a]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/Magic mismatch at offset 1: expected 0xa5, got 0x5a/);
    }
  });

  it('supports multi-byte constants with explicit endianness', () => {
    const Packet = struct({
      size: 5,
      head: [
        magic(u16.be, 0xa55a),
        ['cmd', u8],
        magic(u16.le, 0x0d0a),
      ] as const,
    });

    const encoded = Packet.encode({ head: { cmd: 1 } });
    expect(bytes(encoded)).toEqual([0xa5, 0x5a, 1, 0x0a, 0x0d]);
    expect(Packet.decode(encoded).head).toEqual({ cmd: 1 });
  });

  it('advances the layout offset like a regular field', () => {
    const Packet = struct({
      size: 4,
      head: [
        magic(u16.be, 0xbeef),
        ['value', u16.le],
      ] as const,
    });

    expect(Packet.resolvedFields.value).toMatchObject({ offset: 2, size: 2 });
  });

  it('works in the tail block and allows blocks with only constants', () => {
    const Packet = struct({
      size: 3,
      head: [['cmd', u8]] as const,
      tail: [magic(u16.be, 0x0d0a)] as const,
    });

    const encoded = Packet.encode({ head: { cmd: 9 } });
    expect(bytes(encoded)).toEqual([9, 0x0d, 0x0a]);
    expect(Packet.decode(encoded).tail).toEqual({});
  });

  it('participates in the checksum during encode', () => {
    const Packet = struct({
      size: 3,
      head: [
        magic(u8, 0xa0),
        ['cmd', u8],
      ] as const,
      tail: [['crc', u8]] as const,
      checksum: {
        field: 'crc',
        calculate: (buf) => {
          let sum = 0;
          for (const byte of buf) sum = (sum + byte) & 0xff;
          return sum;
        },
      },
    });

    const encoded = Packet.encode({ head: { cmd: 0x02 }, tail: { crc: 0 } });
    // The checksum includes the magic byte: 0xa0 + 0x02 = 0xa2.
    expect(bytes(encoded)).toEqual([0xa0, 0x02, 0xa2]);
    expect(() => Packet.decode(encoded)).not.toThrow();
  });

  it('is validated before the checksum: a foreign packet is not a CRC mismatch', () => {
    const Packet = struct({
      size: 3,
      head: [
        magic(u8, 0xa5),
        ['cmd', u8],
      ] as const,
      tail: [['crc', u8]] as const,
      checksum: { field: 'crc', calculate: () => 0x11 },
    });

    // Both magic and checksum are invalid, so validation order determines the error.
    const foreign = new Uint8Array([0xee, 0x01, 0x99]);
    const result = Packet.safeDecode(foreign);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/Magic mismatch/);
      expect(result.error.message).not.toMatch(/CRC/);
    }
  });

  it('rejects a bare u16 without endianness at schema description time', () => {
    // @ts-expect-error Bare u16 has no codec - use u16.be or u16.le.
    expect(() => magic(u16, 0xffff)).toThrow(/explicit endianness/);
  });

  it('rejects a data() type at schema description time', () => {
    // @ts-expect-error Magic requires an unsigned integer type.
    expect(() => magic(data({ maxLength: 2 }), 0)).toThrow(/unsigned integer type/);
  });

  it('rejects out-of-range values at schema description time, not at first encode', () => {
    expect(() => magic(u8, 0x1ff)).toThrow(RangeError);
    expect(() => magic(u16.le, -1)).toThrow(RangeError);
    expect(() => magic(u8, 1.5)).toThrow(RangeError);
  });
});
