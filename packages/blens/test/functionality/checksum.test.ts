import { describe, expect, it } from 'bun:test';
import { PacketValidationError, data, skip, struct, u16, u8 } from '@trysquaddf/blens';

const bytes = (buffer: Uint8Array) => Array.from(buffer);

const sumWithoutLast = (buffer: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    sum = (sum + buffer[i]!) & 0xff;
  }
  return sum;
};

describe('checksum', () => {
  it('calculates checksum during encode and validates it during decode', () => {
    const Packet = struct({
      size: 5,
      head: [
        ['kind', u8],
        ['value', u16.be],
      ] as const,
      tail: [
        ['flags', u8],
        ['crc', u8],
      ] as const,
      checksum: {
        field: 'crc',
        calculate: sumWithoutLast,
      },
    });

    const encoded = Packet.encode({
      head: {
        kind: 0x10,
        value: 0x2030,
      },
      tail: {
        flags: 0x40,
        crc: 0,
      },
    });

    expect(bytes(encoded)).toEqual([0x10, 0x20, 0x30, 0x40, 0xa0]);

    const decoded = Packet.decode(encoded);
    expect(decoded.head).toEqual({ kind: 0x10, value: 0x2030 });
    expect(decoded.tail).toEqual({ flags: 0x40, crc: 0xa0 });

    const tampered = new Uint8Array(encoded);
    tampered[1] = 0x21;
    expect(() => Packet.decode(tampered)).toThrow(PacketValidationError);
    expect(() => Packet.decode(tampered)).toThrow(/CRC mismatch/);
  });

  it('supports checksums wider than one byte', () => {
    const Packet = struct({
      size: 3,
      head: [['kind', u8]] as const,
      tail: [['crc', u16.be]] as const,
      checksum: {
        field: 'crc',
        calculate: () => 0x1234,
      },
    });

    const encoded = Packet.encode({
      head: { kind: 7 },
      tail: { crc: 0 },
    });

    expect(bytes(encoded)).toEqual([7, 0x12, 0x34]);
    expect(Packet.decode(encoded).tail.crc).toBe(0x1234);
  });

  it('passes the checksum field position to calculate (real CRCs need to exclude bytes)', () => {
    let seen: { offset: number; size: number } | undefined;
    const Packet = struct({
      size: 4,
      head: [['kind', u8]] as const,
      tail: [skip(1), ['crc', u16.be]] as const,
      checksum: {
        field: 'crc',
        calculate: (_buf, field) => {
          seen = field;
          return 0xbeef;
        },
      },
    });

    Packet.encode({ head: { kind: 1 }, tail: { crc: 0 } });
    expect(seen).toEqual({ offset: 2, size: 2 });
  });

  it('reports CRC mismatch, not a field error, when the length byte is corrupted', () => {
    const Packet = struct({
      size: 5,
      head: [['length', u8]] as const,
      body: data({ lengthField: 'length', maxLength: 3 }),
      tail: [['crc', u8]] as const,
      checksum: { field: 'crc', calculate: sumWithoutLast },
    });

    const encoded = Packet.encode({
      head: { length: 0 },
      body: new Uint8Array([1, 2]),
      tail: { crc: 0 },
    });

    // The invalid length also breaks the checksum, which must be checked first.
    const tampered = new Uint8Array(encoded);
    tampered[0] = 0xff;

    const result = Packet.safeDecode(tampered);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/CRC mismatch/);
      expect(result.error.message).not.toMatch(/exceeds max capacity/);
    }
  });

  it('zeroes the checksum field in the buffer passed to calculate', () => {
    let seenBytes: number[] = [];
    const Packet = struct({
      size: 3,
      head: [['kind', u8], ['value', u8]] as const,
      tail: [['crc', u8]] as const,
      checksum: {
        field: 'crc',
        calculate: (buf) => {
          seenBytes = bytes(buf);
          return 0x42;
        },
      },
    });

    // The callback must receive zero checksum bytes regardless of the placeholder.
    Packet.encode({ head: { kind: 1, value: 2 }, tail: { crc: 0x99 } });
    expect(seenBytes).toEqual([1, 2, 0]);
  });
});

it('matches the CRC-16/CCITT-FALSE check vector with checksum bytes excluded in the middle', () => {
  const Packet = struct({
    size: 11,
    head: [['prefix', data({ maxLength: 4 })], ['crc', u16.le]],
    body: data({ maxLength: 5 }),
    checksum: { field: 'crc', calculate: (buffer, field) => {
      let crc = 0xffff;
      for (let i = 0; i < buffer.length; i++) {
        if (i >= field.offset && i < field.offset + field.size) continue;
        crc ^= buffer[i]! << 8;
        for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
      }
      return crc;
    } },
  });
  // ASCII "123456789" has check value 0x29b1, stored little-endian at offset 4.
  const wire = new Uint8Array([49, 50, 51, 52, 0xb1, 0x29, 53, 54, 55, 56, 57]);
  expect(Packet.decode(wire).head.crc).toBe(0x29b1);
  expect([...Packet.encode({
    head: { prefix: new Uint8Array([49, 50, 51, 52]) },
    body: new Uint8Array([53, 54, 55, 56, 57]),
  })]).toEqual([...wire]);
});
