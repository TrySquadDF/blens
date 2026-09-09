import { describe, expect, it } from 'bun:test';
import { struct, u8, u16, u32 } from 'blens';

// Fixed byte fixtures catch matching byte-order mistakes in encode and decode.
const cases = [
  { name: 'u8', type: u8, value: 0xab, wire: [0xab], max: 0xff },
  { name: 'u16.be', type: u16.be, value: 0x1234, wire: [0x12, 0x34], max: 0xffff },
  { name: 'u16.le', type: u16.le, value: 0x1234, wire: [0x34, 0x12], max: 0xffff },
  { name: 'u32.be', type: u32.be, value: 0xdeadbeef, wire: [0xde, 0xad, 0xbe, 0xef], max: 0xffffffff },
  { name: 'u32.le', type: u32.le, value: 0xdeadbeef, wire: [0xef, 0xbe, 0xad, 0xde], max: 0xffffffff },
];

for (const { name, type, value, wire, max } of cases) {
  describe(name, () => {
    it('reads and writes known wire bytes without touching neighbors', () => {
      const backing = new Uint8Array(type.size + 4).fill(0xcc);
      const view = backing.subarray(1, backing.length - 1);
      type.write(view, 1, value);
      expect([...backing]).toEqual([0xcc, 0xcc, ...wire, 0xcc, 0xcc]);
      expect(type.read(new Uint8Array([0xaa, ...wire, 0xbb]), 1)).toBe(value);
      const field = type.at(1);
      field.encode(view, max);
      expect([...backing]).toEqual([0xcc, 0xcc, ...wire.map(() => 255), 0xcc, 0xcc]);
      expect(field.decode(new Uint8Array([0xaa, ...wire, 0xbb]))).toBe(value);
    });

    it('rejects invalid values before changing any bytes', () => {
      for (const invalid of [-1, max + 1, 0.5, NaN, Infinity, -Infinity]) {
        const buffer = new Uint8Array(type.size).fill(0xcc);
        expect(() => type.write(buffer, 0, invalid)).toThrow(RangeError);
        expect(() => type.at(0).encode(buffer, invalid)).toThrow(RangeError);
        expect([...buffer]).toEqual(wire.map(() => 0xcc));
      }
    });

    it('rejects invalid offsets and truncated fields', () => {
      const buffer = new Uint8Array(type.size).fill(0xcc);
      for (const offset of [-1, 0.5, NaN, Infinity, 1, Number.MAX_SAFE_INTEGER]) {
        expect(() => type.read(buffer, offset)).toThrow(RangeError);
        expect(() => type.write(buffer, offset, value)).toThrow(RangeError);
      }
      expect(() => type.at(0).decode(buffer.subarray(1))).toThrow(RangeError);
      expect(() => type.at(0).encode(buffer.subarray(1), value)).toThrow(RangeError);
      expect([...buffer]).toEqual(wire.map(() => 0xcc));
    });
  });
}

it('rejects multi-byte fields without an explicit byte order', () => {
  for (const type of [u16, u32]) {
    expect(() => struct({
      size: 2,
      // @ts-expect-error Multi-byte fields require an explicit byte order.
      head: [['value', type]],
    })).toThrow(/explicit endianness/);
  }
});
