'use strict';

const { describe, test, expect } = require('bun:test');
const EventEmitter = require('node:events');
const VanitySniper = require('../src/structures/VanitySniper.js');

const makeClient = overrides =>
  Object.assign(new EventEmitter(), { guilds: { cache: new Map() }, options: {}, ...overrides });

const claimRecorder = () => {
  const calls = [];
  return {
    calls,
    fn: async () => {
      calls.push(Date.now());
      return { success: false, vanity: 'tsukoyomi', guildId: '2', attempts: 0, durationMs: 0 };
    },
  };
};

describe('VanitySniper', () => {
  test('normalizeVanity accepts codes, short links and full URLs', () => {
    expect(VanitySniper.normalizeVanity('tsukoyomi')).toBe('tsukoyomi');
    expect(VanitySniper.normalizeVanity('Tsukoyomi')).toBe('tsukoyomi');
    expect(VanitySniper.normalizeVanity('discord.gg/Tsukoyomi')).toBe('tsukoyomi');
    expect(VanitySniper.normalizeVanity('https://discord.com/invite/tsukoyomi')).toBe('tsukoyomi');
    expect(VanitySniper.normalizeVanity('https://discordapp.com/invite/tsukoyomi')).toBe('tsukoyomi');
    expect(VanitySniper.normalizeVanity('/tsukoyomi')).toBe('tsukoyomi');
  });

  test('normalizeVanity rejects invalid inputs', () => {
    expect(() => VanitySniper.normalizeVanity('a')).toThrow();
    expect(() => VanitySniper.normalizeVanity('hello world')).toThrow();
    expect(() => VanitySniper.normalizeVanity('tsukoyomi!')).toThrow();
    expect(() => VanitySniper.normalizeVanity('x'.repeat(26))).toThrow();
    expect(() => VanitySniper.normalizeVanity(42)).toThrow();
  });

  test('resolveGuildId accepts ids and guild-like resolvables', () => {
    expect(VanitySniper.resolveGuildId('123456789012345678')).toBe('123456789012345678');
    expect(VanitySniper.resolveGuildId({ id: '123456789012345678' })).toBe('123456789012345678');
    expect(() => VanitySniper.resolveGuildId('abc')).toThrow();
    expect(() => VanitySniper.resolveGuildId(null)).toThrow();
  });

  test('start/stop manage gateway listeners and emit watching', () => {
    const client = makeClient();
    const sniper = new VanitySniper(client, {
      snipeGuildId: '1',
      claimGuildId: '2',
      vanity: 'tsukoyomi',
      pollInvites: false,
    });

    const events = [];
    sniper.on('watching', info => events.push(info));

    sniper.start();
    expect(sniper.running).toBe(true);
    expect(client.listenerCount('guildUpdate')).toBe(1);
    expect(client.listenerCount('guildDelete')).toBe(1);
    expect(events).toEqual([{ vanity: 'tsukoyomi', snipeGuildId: '1', claimGuildId: '2', armed: false }]);
    expect(sniper.start()).toBe(sniper);

    sniper.stop();
    expect(sniper.running).toBe(false);
    expect(client.listenerCount('guildUpdate')).toBe(0);
    expect(client.listenerCount('guildDelete')).toBe(0);
    expect(sniper.stop()).toBe(sniper);
  });

  test('gateway guildUpdate detects the drop and triggers a claim', () => {
    const client = makeClient();
    const sniper = new VanitySniper(client, {
      snipeGuildId: '1',
      claimGuildId: '2',
      vanity: 'tsukoyomi',
      pollInvites: false,
    });
    const recorder = claimRecorder();
    sniper.claim = recorder.fn;

    const drops = [];
    sniper.on('drop', info => drops.push(info));
    sniper.start();

    client.emit('guildUpdate', { vanityURLCode: 'tsukoyomi' }, { id: '1', vanityURLCode: 'tsukoyomi' });
    expect(sniper.armed).toBe(true);
    expect(drops).toEqual([]);

    client.emit('guildUpdate', { vanityURLCode: 'tsukoyomi' }, { id: '1', vanityURLCode: 'something-else' });
    expect(drops).toEqual([{ source: 'gateway', guildId: '1', oldVanity: 'tsukoyomi', newVanity: 'something-else' }]);
    expect(recorder.calls.length).toBe(1);

    client.emit('guildUpdate', { vanityURLCode: 'other' }, { id: '1', vanityURLCode: null });
    expect(recorder.calls.length).toBe(1);
  });

  test('gateway guildDelete triggers a claim', () => {
    const client = makeClient();
    const sniper = new VanitySniper(client, {
      snipeGuildId: '1',
      claimGuildId: '2',
      vanity: 'tsukoyomi',
      pollInvites: false,
    });
    const recorder = claimRecorder();
    sniper.claim = recorder.fn;

    const drops = [];
    sniper.on('drop', info => drops.push(info));
    sniper.start();

    client.emit('guildDelete', { id: '99' });
    expect(drops).toEqual([]);

    client.emit('guildDelete', { id: '1' });
    expect(drops).toEqual([{ source: 'gateway', guildId: '1', oldVanity: 'tsukoyomi', newVanity: null }]);
    expect(recorder.calls.length).toBe(1);
  });

  test('claim performs a single request on success', async () => {
    let patches = 0;
    const client = makeClient({
      api: {
        guilds: () => ({
          patch: async () => {
            patches += 1;
            return { code: 'tsukoyomi' };
          },
        }),
      },
    });
    const sniper = new VanitySniper(client, { snipeGuildId: '1', claimGuildId: '2', vanity: 'tsukoyomi' });
    const results = [];
    sniper.on('claimed', result => results.push(result));

    const result = await sniper.claim();
    expect(result.success).toBe(true);
    expect(result.vanity).toBe('tsukoyomi');
    expect(result.attempts).toBe(1);
    expect(patches).toBe(1);
    expect(results.length).toBe(1);
    expect(sniper.claiming).toBe(false);
  });

  test('claim solves the MFA challenge lazily and retries with the token', async () => {
    let patches = 0;
    let mfaCalls = 0;
    const requests = [];
    const client = makeClient({
      api: {
        guilds: () => ({
          patch: async request => {
            patches += 1;
            requests.push(request);
            if (patches === 1) {
              const error = new Error('2FA required');
              error.code = 60_003;
              error.httpStatus = 403;
              error.rawError = { mfa: { ticket: 'ticket-1' } };
              throw error;
            }
            return { code: request.data.code };
          },
        }),
        mfa: {
          finish: {
            post: async ({ data }) => {
              mfaCalls += 1;
              expect(data.ticket).toBe('ticket-1');
              expect(data.mfa_type).toBe('totp');
              expect(data.data).toMatch(/^\d{6}$/);
              return { token: 'jwt-1' };
            },
          },
        },
      },
    });
    const sniper = new VanitySniper(client, {
      snipeGuildId: '1',
      claimGuildId: '2',
      vanity: 'tsukoyomi',
      mfaSecret: 'JBSWY3DPEHPK3PXP',
    });

    const result = await sniper.claim();
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(patches).toBe(2);
    expect(mfaCalls).toBe(1);
    expect(requests[1].mfaToken).toBe('jwt-1');
  });

  test('claim reports non-retryable failures', async () => {
    const client = makeClient({
      api: {
        guilds: () => ({
          patch: async () => {
            const error = new Error('rate limited');
            error.code = 0;
            error.httpStatus = 429;
            throw error;
          },
        }),
      },
    });
    const sniper = new VanitySniper(client, { snipeGuildId: '1', claimGuildId: '2', vanity: 'tsukoyomi' });
    const failures = [];
    sniper.on('claimFailed', result => failures.push(result));

    const result = await sniper.claim();
    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(failures.length).toBe(1);
  });

  test('invite polling detects the drop through a 404', async () => {
    const client = makeClient({
      rest: {
        request: async () => {
          const error = new Error('Unknown Invite');
          error.code = 10_006;
          error.httpStatus = 404;
          throw error;
        },
      },
    });
    const sniper = new VanitySniper(client, { snipeGuildId: '1', claimGuildId: '2', vanity: 'tsukoyomi' });
    const recorder = claimRecorder();
    sniper.claim = recorder.fn;

    const drops = [];
    sniper.on('drop', info => drops.push(info));
    sniper.running = true;

    await sniper._pollTick();
    expect(drops).toEqual([{ source: 'poll', guildId: '1', oldVanity: 'tsukoyomi', newVanity: null }]);
    expect(recorder.calls.length).toBe(1);
    sniper.stop();
  });
});
