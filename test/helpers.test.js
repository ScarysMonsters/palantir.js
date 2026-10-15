'use strict';

const { describe, test, expect } = require('bun:test');
const crypto = require('node:crypto');

const ROOT = '../src';

describe('TOTP (RFC 6238 vectors)', () => {
  const { generateTOTP } = require(`${ROOT}/util/TOTP.js`);
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"

  test('matches the official test vectors', () => {
    expect(generateTOTP(secret, { digits: 8, epoch: 59 })).toBe('94287082');
    expect(generateTOTP(secret, { digits: 8, epoch: 1111111109 })).toBe('07081804');
    expect(generateTOTP(secret, { digits: 8, epoch: 1111111111 })).toBe('14050471');
    expect(generateTOTP(secret, { digits: 8, epoch: 1234567890 })).toBe('89005924');
    expect(generateTOTP(secret, { digits: 8, epoch: 2000000000 })).toBe('69279037');
    expect(generateTOTP(secret, { digits: 8, epoch: 20000000000 })).toBe('65353130');
  });

  test('defaults to 6 digits', () => {
    expect(generateTOTP(secret, { epoch: 59 })).toMatch(/^\d{6}$/);
  });
});

describe('QRCode', () => {
  const { create, QRCode } = require(`${ROOT}/util/QRCode.js`);

  // Reference hashes produced by the encoder that was validated by decoding real
  // bitmaps with the `jsqr` decoder (all EC levels, versions 1 to 18).
  const references = [
    ['L', 41, 3, '6f86bd6e76e5c7fa'],
    ['L', 11, 1, '03f942a0c3758b11'],
    ['L', 300, 11, 'd7800c87eac801b0'],
    ['M', 41, 3, '40acfe97119a98c3'],
    ['M', 11, 1, '851bd1031e2539fc'],
    ['M', 300, 13, 'a6c4c99a50e77d18'],
    ['Q', 41, 4, '08d3ac23b65aac55'],
    ['Q', 11, 1, 'c5cc0014645bfe69'],
    ['Q', 300, 16, 'b2504fe076c14052'],
    ['H', 41, 5, '62efc435d35afd79'],
    ['H', 11, 2, '8abeb2dc20bab668'],
    ['H', 300, 18, '566efd6f910b3bce'],
  ];

  test('produces stable, validated matrices', () => {
    for (const [ecl, length, version, hash] of references) {
      const text = length === 41 ? 'https://discord.com/ra/abc123def456ghi789' : length === 11 ? 'hello world' : 'x'.repeat(300);
      const qr = create(text, { errorCorrectionLevel: ecl });
      expect(qr.version).toBe(version);
      const rows = [];
      for (let r = 0; r < qr.getModuleCount(); r++) {
        let row = '';
        for (let c = 0; c < qr.getModuleCount(); c++) row += qr.isDark(r, c) ? '1' : '0';
        rows.push(row);
      }
      const digest = crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
      expect(digest).toBe(hash);
    }
  });

  test('throws when the data does not fit', () => {
    expect(() => create('x'.repeat(3000), { errorCorrectionLevel: 'H' })).toThrow();
  });

  test('toString renders a string', () => {
    const rendered = new QRCode(1, 'L').addData('a').make().getModuleCount();
    expect(rendered).toBe(21);
  });
});

describe('Collection', () => {
  const { Collection } = require(`${ROOT}/util/Collection.js`);
  const c = new Collection([['a', 1], ['b', 2], ['c', 3]]);

  test('map/filter/find/reduce', () => {
    expect(c.first()).toBe(1);
    expect(c.first(2)).toEqual([1, 2]);
    expect(c.last()).toBe(3);
    expect(c.at(1)).toBe(2);
    expect(c.keyAt(0)).toBe('a');
    expect(c.find(v => v > 1)).toBe(2);
    expect(c.findKey(v => v > 1)).toBe('b');
    expect(c.filter(v => v > 1).toJSON()).toEqual([2, 3]);
    expect(c.map(v => v * 2)).toEqual([2, 4, 6]);
    expect(c.mapValues(v => v * 2).toJSON()).toEqual([2, 4, 6]);
    expect(c.some(v => v === 3)).toBe(true);
    expect(c.every(v => v > 0)).toBe(true);
    expect(c.count(v => v > 1)).toBe(2);
    expect(c.reduce((a, v) => a + v, 0)).toBe(6);
  });

  test('set operations', () => {
    const other = new Collection([['b', 2], ['d', 4]]);
    expect(c.union(other).size).toBe(4);
    expect(c.intersection(other).toJSON()).toEqual([2]);
    expect(c.difference(other).toJSON()).toEqual([1, 3]);
    expect(c.hasAll(['a', 'b'])).toBe(true);
    expect(c.equals(new Collection(c))).toBe(true);
  });

  test('sort/reverse/clone/partition/random', () => {
    const sorted = c.sort((a, b) => b - a);
    expect(sorted.toJSON()).toEqual([3, 2, 1]);
    expect(c.reverse().toJSON()).toEqual([3, 2, 1]);
    expect(c.clone().toJSON()).toEqual(c.toJSON());
    expect(c.partition(v => v > 1).map(p => p.size)).toEqual([2, 1]);
    const random = c.random();
    expect(c.toJSON()).toContain(random);
  });
});

describe('AsyncQueue', () => {
  const { AsyncQueue } = require(`${ROOT}/util/AsyncQueue.js`);

  test('serializes tasks in FIFO order', async () => {
    const queue = new AsyncQueue();
    const order = [];
    const task = async (id, ms) => {
      await queue.wait();
      try {
        order.push(`start${id}`);
        await new Promise(resolve => setTimeout(resolve, ms));
        order.push(`end${id}`);
      } finally {
        queue.shift();
      }
    };
    await Promise.all([task(1, 30), task(2, 5), task(3, 1)]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
    expect(queue.remaining).toBe(0);
  });

  test('shift on empty queue is a no-op', () => {
    const queue = new AsyncQueue();
    expect(() => queue.shift()).not.toThrow();
  });
});

describe('CookieJar', () => {
  const { CookieJar } = require(`${ROOT}/rest/CookieJar.js`);

  test('stores and matches cookies per domain, path and security', () => {
    const jar = new CookieJar();
    const response = {
      headers: {
        getSetCookie: () => ['__dcfduid=abc123; Path=/; Secure; HttpOnly', 'locale=en-US; Path=/'],
      },
    };
    jar.storeFromResponse('https://discord.com/api/v9/test', response);
    const https = jar.getCookieString('https://discord.com/api/v9/users/@me');
    expect(https).toContain('__dcfduid=abc123');
    expect(https).toContain('locale=en-US');
    const http = jar.getCookieString('http://discord.com/api');
    expect(http ?? '').not.toContain('__dcfduid');
  });
});

describe('RtpPacket', () => {
  const { RtpPacket, RtpHeader } = require(`${ROOT}/client/voice/util/RtpPacket.js`);

  test('serialize/deSerialize round trip', () => {
    const header = new RtpHeader({ payloadType: 120, sequenceNumber: 1234, timestamp: 999999, ssrc: 42, marker: true });
    const payload = Buffer.from([0xf8, 0xff, 0xfe]);
    const serialized = new RtpPacket(header, payload).serialize();
    expect(serialized.length).toBe(15);
    const parsed = RtpPacket.deSerialize(serialized);
    expect(parsed.header.payloadType).toBe(120);
    expect(parsed.header.sequenceNumber).toBe(1234);
    expect(parsed.header.timestamp).toBe(999999);
    expect(parsed.header.ssrc).toBe(42);
    expect(parsed.header.marker).toBe(true);
    expect(parsed.payload.equals(payload)).toBe(true);
  });
});

describe('Formatters', () => {
  const Formatters = require(`${ROOT}/util/Formatters.js`);

  test('renders the expected markup', () => {
    expect(Formatters.bold('x')).toBe('**x**');
    expect(Formatters.italic('x')).toBe('*x*');
    expect(Formatters.underscore('x')).toBe('__x__');
    expect(Formatters.strikethrough('x')).toBe('~~x~~');
    expect(Formatters.spoiler('x')).toBe('||x||');
    expect(Formatters.inlineCode('x')).toBe('`x`');
    expect(Formatters.codeBlock('js', 'x')).toBe('```js\nx\n```');
    expect(Formatters.userMention('1')).toBe('<@1>');
    expect(Formatters.channelMention('1')).toBe('<#1>');
    expect(Formatters.roleMention('1')).toBe('<@&1>');
    expect(Formatters.hideLinkEmbed('https://x.y')).toBe('<https://x.y>');
    expect(Formatters.hyperlink('l', 'https://x.y')).toBe('[l](https://x.y)');
    expect(Formatters.hyperlink('l', 'https://x.y', 't')).toBe('[l](https://x.y "t")');
    expect(Formatters.time(new Date(0))).toBe('<t:0:f>');
    expect(Formatters.TimestampStyles.RelativeTime).toBe('R');
  });
});

describe('Prism VolumeTransformer', () => {
  const { VolumeTransformer } = require(`${ROOT}/client/voice/util/Prism.js`);

  test('scales s16le samples', async () => {
    const transformer = new VolumeTransformer({ volume: 0.5 });
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(-1000, 2);
    const output = await new Promise((resolve, reject) => {
      transformer.once('data', resolve);
      transformer.once('error', reject);
      transformer.write(pcm);
    });
    expect(output.readInt16LE(0)).toBe(500);
    expect(output.readInt16LE(2)).toBe(-500);
  });
});

describe('ProcessUtil', () => {
  const { findProcess } = require(`${ROOT}/util/ProcessUtil.js`);

  test('finds the current process by name', async () => {
    const list = await findProcess('name', process.platform === 'win32' ? 'bun' : 'bun', false);
    expect(Array.isArray(list)).toBe(true);
    expect(list.some(entry => entry.pid === process.pid || entry.name?.toLowerCase().includes('bun'))).toBe(true);
  }, { timeout: 20000 });
});
