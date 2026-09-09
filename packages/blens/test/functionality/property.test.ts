import { describe, expect, it } from 'bun:test';
import { data, struct, u16, u32, u8 } from '@trysquaddf/blens';
import type { TypeDef } from '@trysquaddf/blens';

// Fixed seeds keep randomized offset and boundary checks reproducible.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SEED = 0x0c7e701;
const ITERATIONS = 250;

describe('property: uint wire compatibility with DataView', () => {
  const cases: Array<[string, TypeDef<number>, 1 | 2 | 4, boolean]> = [
    ['u8', u8, 1, false],
    ['u16.be', u16.be, 2, false], ['u16.le', u16.le, 2, true],
    ['u32.be', u32.be, 4, false], ['u32.le', u32.le, 4, true],
  ];
  for (const [name, type, size, littleEndian] of cases) {
    it(`${name}: independent encoder and decoder agree at boundaries and random values`, () => {
      const rand = mulberry32(SEED);
      const max = 2 ** (size * 8) - 1;
      const values = [0, 1, max, max - 1, Math.floor(max / 2), Math.floor(max / 2) + 1,
        ...Array.from({ length: ITERATIONS }, () => Math.floor(rand() * (max + 1)))];
      for (const value of values) {
        const expected = new Uint8Array(size + 4).fill(0xcc);
        const reference = new DataView(expected.buffer, 1, size + 2);
        if (size === 1) reference.setUint8(1, value);
        else if (size === 2) reference.setUint16(1, value, littleEndian);
        else reference.setUint32(1, value, littleEndian);
        const actual = new Uint8Array(size + 4).fill(0xcc);
        type.write(actual.subarray(1), 1, value);
        expect([...actual]).toEqual([...expected]);
        expect(type.read(expected.subarray(1), 1)).toBe(value);
      }
    });
  }
});

describe('property: packet round-trips', () => {
  const makePacket = () => struct({
    size: 10,
    head: [
      ['cmd', u8],
      ['length', u8],
      ['param', u16.le],
    ] as const,
    body: data({ lengthField: 'length', maxLength: 4 }),
    tail: [
      ['seq', u8],
      ['crc', u8],
    ] as const,
    checksum: {
      field: 'crc',
      calculate: (buf) => {
        let sum = 0;
        for (const byte of buf) sum = (sum + byte) & 0xff;
        return (0x55 - sum) & 0xff;
      },
    },
  });

  it('preserves user fields and normalizes length/checksum for random payloads', () => {
    const rand = mulberry32(SEED);
    const Packet = makePacket();

    for (let i = 0; i < ITERATIONS; i++) {
      const bodyLength = Math.floor(rand() * 5);
      const body = new Uint8Array(bodyLength);
      for (let b = 0; b < bodyLength; b++) body[b] = Math.floor(rand() * 256);

      const input = {
        head: {
          cmd: Math.floor(rand() * 256),
          // The computed length must ignore the supplied placeholder.
          length: Math.floor(rand() * 256),
          param: Math.floor(rand() * 0x10000),
        },
        body,
        tail: {
          seq: Math.floor(rand() * 256),
          crc: 0,
        },
      };

      const decoded = Packet.decode(Packet.encode(input));

      expect(decoded.head.cmd).toBe(input.head.cmd);
      expect(decoded.head.param).toBe(input.head.param);
      expect(decoded.head.length).toBe(bodyLength);
      expect(Array.from(decoded.body)).toEqual(Array.from(body));
      expect(decoded.tail.seq).toBe(input.tail.seq);
      const sum = input.head.cmd + bodyLength + (input.head.param & 255)
        + (input.head.param >>> 8) + body.reduce((total, byte) => total + byte, 0) + input.tail.seq;
      expect(decoded.tail.crc).toBe((0x55 - sum) & 255);
    }
  });

  it('rejects every single-byte substitution in two independent wire fixtures', () => {
    const Packet = makePacket();
    const fixtures = [
      new Uint8Array([1, 0, 0x34, 0x12, 0, 0, 0, 0, 9, 5]),
      new Uint8Array([1, 3, 0x34, 0x12, 1, 2, 3, 0, 9, 252]),
    ];
    for (const fixture of fixtures) {
      expect(Packet.safeDecode(fixture).success).toBe(true);
      for (let pos = 0; pos < fixture.length; pos++) {
        for (let byte = 0; byte < 256; byte++) {
          if (byte === fixture[pos]) continue;
          const tampered = fixture.slice();
          tampered[pos] = byte;
          if (Packet.safeDecode(tampered).success) {
            throw new Error(`Accepted corruption at offset ${pos}: ${fixture[pos]} -> ${byte}`);
          }
        }
      }
    }
  });
});
