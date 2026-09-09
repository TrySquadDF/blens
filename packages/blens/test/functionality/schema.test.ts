import { describe, expect, it } from 'bun:test';
import { data, skip, struct, u16, u32, u8 } from 'blens';

const sumWithoutLast = (buffer: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    sum = (sum + buffer[i]!) & 0xff;
  }
  return sum;
};

describe('schema compilation', () => {
  it('stores compiled field offsets and sizes from head, body, tail and skips', () => {
    const Packet = struct({
      size: 15,
      head: [
        ['sync', u8],
        skip(2),
        ['length', u16.be],
      ] as const,
      body: data({ lengthField: 'length', maxLength: 4 }),
      tail: [
        ['status', u8],
        skip(1),
        ['packetId', u32.le],
      ] as const,
    });

    expect(Packet.resolvedFields.sync).toMatchObject({ offset: 0, size: 1 });
    expect(Packet.resolvedFields.length).toMatchObject({ offset: 3, size: 2 });
    expect(Packet.resolvedFields.status).toMatchObject({ offset: 9, size: 1 });
    expect(Packet.resolvedFields.packetId).toMatchObject({ offset: 11, size: 4 });
    expect(Object.keys(Packet.resolvedFields)).toEqual([
      'sync',
      'length',
      'status',
      'packetId',
    ]);
  });

  it('rejects layouts that do not exactly match the declared packet size', () => {
    expect(() => struct({
      size: 1,
      head: [['value', u16.be]] as const,
    })).toThrow(/Compiled layout size 2 does not match schema size 1/);

    expect(() => struct({
      size: 2,
      head: [['value', u8]] as const,
    })).toThrow(/Represent reserved bytes explicitly with skip/);
  });

  it('rejects duplicate field names across head and tail at runtime too', () => {
    expect(() => {
      // @ts-expect-error Head and tail contain the same field name.
      struct({
        size: 2,
        head: [['same', u8]] as const,
        tail: [['same', u8]] as const,
      });
    }).toThrow(/Duplicate field name "same"/);
  });

  it('rejects a missing dynamic length field while compiling the schema', () => {
    // @ts-expect-error The length reference does not identify a head field.
    expect(() => struct({
      size: 2,
      body: data({ lengthField: 'missing', maxLength: 2 }),
    })).toThrow(/Length field "missing" must exist in head/);
  });

  it('rejects a lengthField that points to a non-numeric (data) field', () => {
    // @ts-expect-error Length references must identify numeric head fields.
    expect(() => struct({
      size: 5,
      head: [['len', data({ maxLength: 1 })]] as const,
      body: data({ lengthField: 'len', maxLength: 4 }),
    })).toThrow(/Length field "len" must be an unsigned integer/);
  });

  it('rejects a checksum config that points to a missing field (type- and runtime-level)', () => {
    expect(() =>
      struct({
        size: 1,
        head: [['kind', u8]] as const,
        checksum: {
          // @ts-expect-error The checksum reference does not identify a schema field.
          field: 'crc',
          calculate: sumWithoutLast,
        },
      }),
    ).toThrow(/Checksum field "crc" not found/);
  });

  it('rejects a checksum field that points to a non-numeric (data) field', () => {
    expect(() => struct({
      size: 2,
      head: [['kind', u8]] as const,
      tail: [['crc', data({ maxLength: 1 })]] as const,
      // @ts-expect-error Checksum references must identify numeric fields.
      checksum: { field: 'crc', calculate: () => 7 },
    })).toThrow(/Checksum field "crc" must be an unsigned integer/);
  });
});

describe('schema invariants', () => {
  for (const [name, type] of [['u8', u8], ['u16.le', u16.le], ['u16.be', u16.be], ['u32.le', u32.le], ['u32.be', u32.be]] as const) {
    const capacity = 2 ** (type.size * 8) - 1;
    it(`checks ${name} length capacity at schema creation and direct binding`, () => {
      const field = type.at(0);
      expect(() => data({ lengthField: 'length', maxLength: capacity }).at(type.size, () => field))
        .not.toThrow();
      expect(() => data({ lengthField: 'length', maxLength: capacity + 1 }).at(type.size, () => field))
        .toThrow(/exceeds length field "length" capacity/);
      expect(() => struct({
        size: type.size + capacity + 1,
        head: [['length', type]],
        body: data({ lengthField: 'length', maxLength: capacity + 1 }),
      })).toThrow(/exceeds length field "length" capacity/);
    });
  }

  it('encodes the full supported u8 payload capacity without truncation', () => {
    const Packet = struct({
      size: 256, head: [['length', u8]],
      body: data({ lengthField: 'length', maxLength: 255 }),
    });
    const payload = Uint8Array.from({ length: 255 }, (_, i) => i);
    const encoded = Packet.encode({ body: payload });
    expect([...encoded]).toEqual([255, ...payload]);
    expect(Packet.decode(encoded).body).toEqual(payload);
  });

  it('rejects raw skip markers that would overlap fields', () => {
    expect(() => struct({ size: 1, head: [['a', u8], { skip: -1 }, ['b', u8]] })).toThrow(/Skip size/);
    for (const invalid of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => struct({ size: 1, head: [{ skip: invalid }, ['a', u8]] })).toThrow(/Skip size/);
    }
  });

  it('rejects invalid schema and custom field sizes before binding fields', () => {
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => struct({ size: invalid })).toThrow(RangeError);
      expect(() => struct({ size: 1, head: [['x', { ...u8, size: invalid }]] })).toThrow(RangeError);
    }
  });

  it('rejects assigning both payload length and checksum to one field', () => {
    expect(() => struct({
      size: 3, head: [['length', u8]],
      body: data({ lengthField: 'length', maxLength: 2 }),
      checksum: { field: 'length', calculate: () => 30 },
    })).toThrow(/both.*length.*checksum/i);
  });

  it('rejects dynamic data inside head or tail instead of ignoring its length', () => {
    const dynamic = data({ lengthField: 'length', maxLength: 2 });
    expect(() => struct({ size: 3, head: [['length', u8], ['bytes', dynamic]] }))
      .toThrow(/lengthField.*body/);
    expect(() => struct({ size: 3, head: [['length', u8]], tail: [['bytes', dynamic]] }))
      .toThrow(/lengthField.*body/);
  });

  it('keeps compiled behavior after the original schema is edited', () => {
    const head: Array<readonly ['value', typeof u8]> = [['value', u8]];
    const schema = {
      size: 2, head, tail: [['crc', u8]] as const,
      checksum: { field: 'crc' as const, calculate: (b: Uint8Array) => b[0]! },
    };
    const Packet = struct(schema);
    schema.size = 9;
    head.length = 0;
    schema.checksum.calculate = () => 99;
    expect(Packet.size).toBe(2);
    expect([...Packet.encode({ head: { value: 7 }, tail: { crc: 0 } })]).toEqual([7, 7]);
    expect(Packet.decode(new Uint8Array([7, 7])).head.value).toBe(7);
  });
});

it('validates actual names in dynamically assembled blocks', () => {
  const head: import('blens').LayoutEntry[] = [['a', u8]];
  const tail: import('blens').LayoutEntry[] = [['b', u8]];
  expect([...struct({ size: 2, head, tail }).encode({ head: { a: 1 }, tail: { b: 2 } })]).toEqual([1, 2]);
  tail[0] = ['a', u8];
  expect(() => struct({ size: 2, head, tail })).toThrow(/Duplicate field name "a"/);
});
