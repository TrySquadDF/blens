import { describe, expect, it } from 'bun:test';
import { u8, data } from 'blens';

describe('data() field', () => {
  describe('core factory', () => {
    it('write/read round-trip copies bytes at the given offset', () => {
      const d = data({ maxLength: 4 });
      const buf = new Uint8Array(8);
      const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

      d.write(buf, 2, payload);
      expect(Array.from(buf)).toEqual([0, 0, 0xaa, 0xbb, 0xcc, 0xdd, 0, 0]);
      expect(Array.from(d.read(buf, 2))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });

    it('leaves unused capacity untouched when writing into a reused buffer', () => {
      const d = data({ maxLength: 4 });
      const buf = new Uint8Array([9, 9, 9, 9]);

      d.write(buf, 0, new Uint8Array([1]));

      expect(Array.from(buf)).toEqual([1, 9, 9, 9]);
    });

    it('read returns maxLength bytes regardless of actual payload', () => {
      const d = data({ maxLength: 4 });
      const buf = new Uint8Array([0x11, 0x22, 0x00, 0x00]);

      expect(Array.from(d.read(buf, 0))).toEqual([0x11, 0x22, 0x00, 0x00]);
    });

    it('rejects non-Uint8Array payloads loudly (no silent no-op)', () => {
      const d = data({ maxLength: 4 });
      const buf = new Uint8Array(4);

      // Uint8Array.set silently ignores a number, so the field must validate it.
      expect(() => d.write(buf, 0, 42 as unknown as Uint8Array)).toThrow(TypeError);
      expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
    });
  });

  describe('overflow guard', () => {
    it('throws when payload exceeds maxLength', () => {
      const d = data({ maxLength: 2 });
      const tooBig = new Uint8Array([1, 2, 3]);

      expect(() => d.write(new Uint8Array(3), 0, tooBig)).toThrow(/exceeds max capacity/);
    });

    it('accepts payload exactly at maxLength boundary', () => {
      const d = data({ maxLength: 3 });
      const buf = new Uint8Array(3);
      const exact = new Uint8Array([1, 2, 3]);

      expect(() => d.write(buf, 0, exact)).not.toThrow();
      expect(Array.from(buf)).toEqual([1, 2, 3]);
    });
  });

  describe('lengthField resolver', () => {
    const makeLayout = () => {
      const lenField = u8.at(0);
      const payloadField = data({ lengthField: 'len', maxLength: 4 }).at(
        1,
        (name) => (name === 'len' ? lenField : undefined),
      );
      return { lenField, payloadField };
    };

    it('encode writes the payload length into the referenced field', () => {
      const { lenField, payloadField } = makeLayout();
      const buf = new Uint8Array([9, 9, 9, 9, 9]);
      const payload = new Uint8Array([0xaa, 0xbb]);

      payloadField.encode(buf, payload);

      expect(lenField.decode(buf)).toBe(2);
      expect(Array.from(buf)).toEqual([2, 0xaa, 0xbb, 9, 9]);
    });

    it('direct factory writes do not update a configured length field', () => {
      const d = data({ lengthField: 'len', maxLength: 4 });
      const buf = new Uint8Array([9, 9, 9, 9, 9]);

      d.write(buf, 1, new Uint8Array([1]));

      expect(Array.from(buf)).toEqual([9, 1, 9, 9, 9]);
    });

    it('decode trims the payload to the stored length', () => {
      const { payloadField } = makeLayout();
      const buf = new Uint8Array([3, 0x01, 0x02, 0x03, 0xff]); // The final byte is outside the stored length.

      const decoded = payloadField.decode(buf);

      expect(Array.from(decoded)).toEqual([0x01, 0x02, 0x03]);
    });

    it('decode with length 0 returns an empty Uint8Array', () => {
      const { payloadField } = makeLayout();
      const buf = new Uint8Array([0, 0xaa, 0xbb, 0xcc, 0xdd]);

      expect(Array.from(payloadField.decode(buf))).toEqual([]);
    });

    it('rejects unresolved length references at binding time', () => {
      const field = data({ lengthField: 'len', maxLength: 4 });
      expect(() => field.at(1)).toThrow(/requires a resolver/);
      expect(() => field.at(1, () => undefined)).toThrow(/requires a resolver/);
    });
  });
});

it('rejects invalid capacities and buffer ranges before writing', () => {
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => data({ maxLength: invalid })).toThrow(RangeError);
  }
  expect(() => data({ maxLength: 1, lengthField: '' })).toThrow(/must not be empty/);
  const d = data({ maxLength: 2 });
  const buffer = new Uint8Array([0xcc, 0xcc]);
  for (const offset of [-1, 0.5, NaN, Infinity, 1]) {
    expect(() => d.write(buffer, offset, new Uint8Array([1]))).toThrow(RangeError);
    expect(() => d.read(buffer, offset)).toThrow(RangeError);
  }
  expect(() => d.write(buffer, 0, new Uint8Array([1, 2, 3]))).toThrow(/capacity/);
  expect([...buffer]).toEqual([0xcc, 0xcc]);
});
