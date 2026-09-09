import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'bun:test';
import { data, struct, u8, u16, u32 } from '@trysquaddf/blens';

// Views deliberately have a nonzero byteOffset and bytes outside the packet.
// Expected wire bytes are fixtures, not the output of the encoder under test.
for (const storage of ['Uint8Array', 'Buffer'] as const) {
  const viewOf = (bytes: number[]) => {
    const backing = storage === 'Buffer' ? Buffer.from(bytes) : new Uint8Array(bytes);
    return { backing, view: backing.subarray(1, backing.length - 1) };
  };

  describe(`${storage}: checksum preserves caller memory`, () => {
    for (const outcome of ['success', 'mismatch', 'throw', 'invalid'] as const) {
      it(`isolates callback writes and retained buffers on ${outcome}`, () => {
        const retained: Uint8Array[] = [];
        const boom = new Error('mutating callback failed');
        const Packet = struct({
          size: 3, head: [['command', u8]],
          body: data({ maxLength: 1 }), tail: [['crc', u8]],
          checksum: { field: 'crc', calculate: snapshot => {
            expect([...snapshot]).toEqual([7, 9, 0]);
            retained.push(snapshot);
            snapshot.fill(0xff);
            if (outcome === 'throw') throw boom;
            return outcome === 'invalid' ? NaN : outcome === 'mismatch' ? 17 : 16;
          } },
        });
        const original = [0xaa, 7, 9, 16, 0xbb];
        const { backing, view } = viewOf(original);
        const first = Packet.safeDecode(view);
        const second = Packet.safeDecode(view);
        expect([...backing]).toEqual(original);
        expect(first.success).toBe(outcome === 'success');
        expect(second.success).toBe(outcome === 'success');
        expect(retained[0]).not.toBe(retained[1]);
        expect(retained[0]?.buffer).not.toBe(view.buffer);
        retained[0]!.fill(0);
        expect([...retained[1]!]).toEqual([255, 255, 255]);
        expect([...backing]).toEqual(original);
        if (first.success) {
          expect(first.data.head.command).toBe(7);
          expect([...first.data.body]).toEqual([9]);
          const payload = new Uint8Array([9]);
          const encoded = Packet.encode({ head: { command: 7 }, body: payload });
          retained[2]!.fill(0);
          expect([...encoded]).toEqual([7, 9, 16]);
          expect([...payload]).toEqual([9]);
        } else if (outcome === 'throw') {
          expect(first.error.cause).toBe(boom);
        }
      });
    }

    const cases = [
      { name: 'u8', type: u8, value: 0x83, wire: [0x83] },
      { name: 'u16.be', type: u16.be, value: 0x8123, wire: [0x81, 0x23] },
      { name: 'u16.le', type: u16.le, value: 0x8123, wire: [0x23, 0x81] },
      { name: 'u32.be', type: u32.be, value: 0xfedcba98, wire: [0xfe, 0xdc, 0xba, 0x98] },
      { name: 'u32.le', type: u32.le, value: 0xfedcba98, wire: [0x98, 0xba, 0xdc, 0xfe] },
    ];
    for (const { name, type, value, wire } of cases) {
      it(`${name}: repeated decoding returns the original checksum`, () => {
        const Packet = struct({
          size: type.size + 2,
          head: [['command', u8], ['crc', type]] as const,
          tail: [['status', u8]] as const,
          checksum: { field: 'crc', calculate: b => {
            expect([...b]).toEqual([7, ...wire.map(() => 0), 9]);
            return value;
          } },
        });
        const original = [0xaa, 7, ...wire, 9, 0xbb];
        const { backing, view } = viewOf(original);
        for (let i = 0; i < 2; i++) {
          expect(Packet.decode(view).head.crc).toBe(value);
          expect([...backing]).toEqual(original);
        }
      });
    }

    for (const failure of ['mismatch', 'throw', 'invalid'] as const) {
      it(`restores all bytes after ${failure}`, () => {
        const boom = new Error('checksum callback failed');
        const Packet = struct({
          size: 3,
          head: [['command', u8]] as const,
          tail: [['crc', u16.be]] as const,
          checksum: { field: 'crc', calculate: () => {
            if (failure === 'throw') throw boom;
            return failure === 'invalid' ? NaN : 0;
          } },
        });
        const original = [0xaa, 7, 0x81, 0x23, 0xbb];
        const { backing, view } = viewOf(original);
        const result = Packet.safeDecode(view);
        expect(result.success).toBe(false);
        if (result.success) throw new Error('Expected checksum rejection');
        if (failure === 'throw') expect(result.error.cause).toBe(boom);
        else expect(result.error.message).toMatch(failure === 'mismatch' ? /CRC mismatch/ : /Checksum must/);
        expect([...backing]).toEqual(original);
      });
    }
  });

  describe(`${storage}: payload ownership`, () => {
    for (const dynamic of [false, true]) {
      it(`${dynamic ? 'dynamic' : 'fixed'} body is independent in both directions`, () => {
        const Packet = struct({
          size: 4,
          head: [['length', u8]] as const,
          body: data({ maxLength: 3, ...(dynamic ? { lengthField: 'length' } : {}) }),
        });
        const { backing, view } = viewOf([0xaa, 2, 10, 20, 30, 0xbb]);
        const decoded = Packet.decode(view);
        view[1] = 99;
        expect([...decoded.body]).toEqual(dynamic ? [10, 20] : [10, 20, 30]);
        decoded.body[1] = 88;
        expect([...backing]).toEqual([0xaa, 2, 99, 20, 30, 0xbb]);
      });
    }

    it('named data fields also own their bytes', () => {
      const Packet = struct({ size: 2, head: [['bytes', data({ maxLength: 2 })]] as const });
      const { view } = viewOf([0xaa, 10, 20, 0xbb]);
      const decoded = Packet.decode(view);
      view[0] = 99;
      expect([...decoded.head.bytes]).toEqual([10, 20]);
      decoded.head.bytes[1] = 88;
      expect([...view]).toEqual([99, 20]);
    });
  });
}
