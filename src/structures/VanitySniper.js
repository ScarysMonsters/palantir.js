'use strict';

const EventEmitter = require('node:events');
const { setTimeout } = require('node:timers');
const { generateTOTP } = require('../util/TOTP');
const { Error } = require('../errors');

const VANITY_CODE_REGEX = /^[a-z0-9_.-]{2,25}$/;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const claimBackoff = attempt => Math.round(Math.random() * Math.min(8_000, 250 * 2 ** attempt));

/**
 * Represents the result of a vanity claim attempt.
 * @typedef {Object} VanitySnipResult
 * @property {boolean} success Whether the vanity was claimed
 * @property {string} vanity The vanity code
 * @property {Snowflake} guildId The guild where the vanity was claimed
 * @property {number} attempts The number of claim attempts
 * @property {number} durationMs How long the claim took
 * @property {number} [status] HTTP status of the last failed attempt
 * @property {number} [code] Discord error code of the last failed attempt
 * @property {string} [error] Short error identifier
 */

/**
 * Watches a vanity code and claims it on another guild as soon as it is released.
 * Detection uses the gateway (`guildUpdate` / `guildDelete` of the watched guild) plus an
 * optional invite polling fallback. The claim is a single bounded `PATCH /guilds/:id/vanity-url`:
 * on a `60003` (2FA required) answer, the challenge is solved lazily with the configured TOTP
 * secret or password, and the same request is retried once with the MFA token.
 * @extends {EventEmitter}
 * @example
 * const sniper = client.user.setSniper('123456789012345678', '234567890123456789', 'tsukoyomi');
 * sniper.on('claimed', result => console.log(`claimed /${result.vanity} in ${result.durationMs}ms`));
 * sniper.on('claimFailed', result => console.error(result));
 */
class VanitySniper extends EventEmitter {
  /**
   * @param {Client} client The client to use
   * @param {Object} options The sniper configuration
   * @param {Snowflake} options.snipeGuildId The guild holding the vanity to watch
   * @param {Snowflake} options.claimGuildId The guild where the vanity will be claimed
   * @param {string} options.vanity The normalized vanity code
   * @param {?string} [options.mfaSecret] TOTP secret used to solve a 2FA challenge
   * @param {?string} [options.password] Account password used to solve a 2FA challenge
   * @param {?string} [options.mfaType] Force the MFA type: `totp` or `password`
   * @param {boolean} [options.pollInvites=true] Poll `GET /invites/:code` as a fallback detection
   * @param {number} [options.pollIntervalMs=1500] Polling interval in milliseconds
   * @param {number} [options.maxClaimAttempts=4] Maximum attempts for retryable claim failures
   * @param {boolean} [options.keepWatching=false] Keep watching after a successful claim
   */
  constructor(client, options) {
    super();

    /**
     * The client this sniper is attached to
     * @type {Client}
     */
    this.client = client;

    /**
     * The guild holding the vanity that is being watched
     * @type {Snowflake}
     */
    this.snipeGuildId = options.snipeGuildId;

    /**
     * The guild where the vanity will be claimed
     * @type {Snowflake}
     */
    this.claimGuildId = options.claimGuildId;

    /**
     * The vanity code that is being sniped
     * @type {string}
     */
    this.vanity = options.vanity;

    /**
     * The TOTP secret used for 2FA challenges, if any
     * @type {?string}
     */
    this.mfaSecret = options.mfaSecret ?? null;

    /**
     * The account password used for 2FA challenges, if TOTP is not configured
     * @type {?string}
     */
    this.password = options.password ?? null;

    /**
     * The MFA type used to answer challenges
     * @type {string}
     */
    this.mfaType = options.mfaType ?? (this.mfaSecret ? 'totp' : this.password ? 'password' : 'totp');

    /**
     * Whether invite polling is enabled
     * @type {boolean}
     */
    this.pollInvites = options.pollInvites !== false;

    /**
     * The polling interval in milliseconds
     * @type {number}
     */
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_500);

    /**
     * Maximum attempts for retryable claim failures
     * @type {number}
     */
    this.maxClaimAttempts = Math.max(1, options.maxClaimAttempts ?? 4);

    /**
     * Whether the sniper keeps watching after a successful claim
     * @type {boolean}
     */
    this.keepWatching = Boolean(options.keepWatching);

    /**
     * Whether the sniper is currently watching
     * @type {boolean}
     */
    this.running = false;

    /**
     * Whether a claim is currently in flight
     * @type {boolean}
     */
    this.claiming = false;

    /**
     * Whether the watched vanity has been observed on the origin guild
     * @type {boolean}
     */
    this.armed = false;

    /**
     * Consecutive polling failures
     * @type {number}
     */
    this.pollStreak = 0;

    /**
     * Timestamp until which polling is paused after repeated failures
     * @type {number}
     */
    this.pollCooldownUntil = 0;

    this._pollTimer = null;
    this._mfaPromise = null;
    this._onGuildUpdate = (oldGuild, newGuild) => this._handleGuildUpdate(oldGuild, newGuild);
    this._onGuildDelete = guild => this._handleGuildDelete(guild);
  }

  /**
   * Normalizes a vanity input (`code`, `discord.gg/code` or a full URL) into a plain code
   * @param {string} input The vanity input
   * @returns {string}
   */
  static normalizeVanity(input) {
    if (typeof input !== 'string') throw new Error('VANITY_SNIPER_INVALID_CODE');
    const code = input
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^(?:www\.)?(?:discord\.gg|discord(?:app)?\.com)\//, '')
      .replace(/^invite\//, '')
      .replace(/^\//, '');
    if (!VANITY_CODE_REGEX.test(code)) throw new Error('VANITY_SNIPER_INVALID_CODE');
    return code;
  }

  /**
   * Resolves a guild resolvable into a guild id
   * @param {GuildResolvable} resolvable The guild or guild id
   * @returns {Snowflake}
   */
  static resolveGuildId(resolvable) {
    if (resolvable && typeof resolvable === 'object' && 'id' in resolvable) return resolvable.id;
    const id = String(resolvable ?? '');
    if (!/^\d{16,20}$/.test(id)) throw new Error('VANITY_SNIPER_INVALID_GUILD');
    return id;
  }

  /**
   * Starts watching the origin guild and polling if enabled
   * @returns {this}
   */
  start() {
    if (this.running) return this;
    this.running = true;

    const guild = this.client.guilds.cache.get(this.snipeGuildId);
    this.armed = guild?.vanityURLCode === this.vanity;

    this.client.on('guildUpdate', this._onGuildUpdate);
    this.client.on('guildDelete', this._onGuildDelete);
    if (this.pollInvites) this._schedulePoll();

    this._debug(`watching /${this.vanity} (${this.snipeGuildId}) -> claim on ${this.claimGuildId}${this.armed ? ' [armed]' : ''}`);
    this.emit('watching', {
      vanity: this.vanity,
      snipeGuildId: this.snipeGuildId,
      claimGuildId: this.claimGuildId,
      armed: this.armed,
    });
    return this;
  }

  /**
   * Stops watching and clears every timer and listener
   * @returns {this}
   */
  stop() {
    if (!this.running) return this;
    this.running = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this.client.off('guildUpdate', this._onGuildUpdate);
    this.client.off('guildDelete', this._onGuildDelete);
    this._debug(`stopped watching /${this.vanity}`);
    return this;
  }

  /**
   * Claims the vanity on the claim guild. Single request first, one bounded MFA retry, and
   * bounded retries with backoff for network or server errors.
   * @returns {Promise<VanitySnipResult>}
   */
  async claim() {
    if (this.claiming) {
      return { success: false, vanity: this.vanity, guildId: this.claimGuildId, attempts: 0, durationMs: 0, error: 'ALREADY_CLAIMING' };
    }
    this.claiming = true;
    const started = Date.now();

    try {
      let attempts = 0;
      while (true) {
        attempts += 1;
        try {
          const data = await this.client.api.guilds(this.claimGuildId, 'vanity-url').patch({
            data: { code: this.vanity },
          });
          return this._succeed(data, attempts, started);
        } catch (error) {
          const ticket = error.code === 60_003 ? error.rawError?.mfa?.ticket : null;
          if (ticket) {
            const mfaToken = await this._resolveMfa(ticket);
            if (mfaToken) {
              try {
                const data = await this.client.api.guilds(this.claimGuildId, 'vanity-url').patch({
                  data: { code: this.vanity },
                  mfaToken,
                });
                return this._succeed(data, attempts + 1, started);
              } catch (retryError) {
                const result = this._failed(retryError, attempts + 1, started);
                this.emit('claimFailed', result);
                return result;
              }
            }
            const result = this._failed(error, attempts, started, 'MFA_RESOLUTION_FAILED');
            this.emit('claimFailed', result);
            return result;
          }

          const status = error.httpStatus ?? 0;
          if ((status === 0 || status >= 500) && attempts < this.maxClaimAttempts) {
            const delay = claimBackoff(attempts);
            this._debug(`claim ${status || 'network'} - retry in ${delay}ms (${attempts}/${this.maxClaimAttempts})`);
            await sleep(delay);
            continue;
          }

          const result = this._failed(error, attempts, started);
          this.emit('claimFailed', result);
          return result;
        }
      }
    } finally {
      this.claiming = false;
    }
  }

  _succeed(data, attempts, started) {
    const result = {
      success: true,
      vanity: data?.code ?? this.vanity,
      guildId: this.claimGuildId,
      attempts,
      durationMs: Date.now() - started,
    };
    this._debug(`claimed /${result.vanity} in ${result.durationMs}ms (attempt ${attempts})`);
    this.emit('claimed', result);
    if (!this.keepWatching) this.stop();
    return result;
  }

  _failed(error, attempts, started, identifier) {
    const result = {
      success: false,
      vanity: this.vanity,
      guildId: this.claimGuildId,
      attempts,
      durationMs: Date.now() - started,
      status: error?.httpStatus ?? 0,
      code: error?.code ?? null,
      error: identifier ?? 'CLAIM_FAILED',
    };
    this._debug(`claim failed (${result.status}${result.code ? ` / ${result.code}` : ''}) after ${attempts} attempt(s)`);
    return result;
  }

  async _resolveMfa(ticket) {
    if (this._mfaPromise) return this._mfaPromise;
    this._mfaPromise = this._doResolveMfa(ticket).finally(() => {
      this._mfaPromise = null;
    });
    return this._mfaPromise;
  }

  async _doResolveMfa(ticket) {
    let data;
    if (this.mfaType === 'totp') {
      if (!this.mfaSecret) return null;
      data = generateTOTP(this.mfaSecret);
    } else {
      if (!this.password) return null;
      data = this.password;
    }

    try {
      const response = await this.client.api.mfa.finish.post({
        data: { ticket, mfa_type: this.mfaType, data },
      });
      if (response?.token) {
        this._debug(`mfa resolved (${this.mfaType})`);
        return response.token;
      }
      return null;
    } catch (error) {
      this._debug(`mfa/finish failed (${error.httpStatus ?? 0})`);
      return null;
    }
  }

  _handleGuildUpdate(oldGuild, newGuild) {
    if (!this.running || newGuild.id !== this.snipeGuildId) return;

    const oldCode = oldGuild.vanityURLCode ?? null;
    const newCode = newGuild.vanityURLCode ?? null;

    if (newCode === this.vanity) {
      this.armed = true;
      return;
    }

    if (oldCode === this.vanity && newCode !== this.vanity) {
      this.emit('drop', {
        source: 'gateway',
        guildId: newGuild.id,
        oldVanity: oldCode,
        newVanity: newCode,
      });
      void this.claim();
    }
  }

  _handleGuildDelete(guild) {
    if (!this.running || guild.id !== this.snipeGuildId) return;
    this.emit('drop', { source: 'gateway', guildId: guild.id, oldVanity: this.vanity, newVanity: null });
    void this.claim();
  }

  _schedulePoll(delay) {
    if (!this.running || !this.pollInvites) return;
    const wait = delay ?? Math.round(this.pollIntervalMs * (0.75 + Math.random() * 0.5));
    this._pollTimer = setTimeout(() => void this._pollTick(), wait);
    this._pollTimer.unref?.();
  }

  async _pollTick() {
    if (!this.running) return;

    if (Date.now() < this.pollCooldownUntil) {
      this._schedulePoll(2_000);
      return;
    }

    try {
      await this.client.rest.request('get', `/invites/${encodeURIComponent(this.vanity)}`, {
        auth: false,
        route: 'GET /invites/:code',
      });
      this.pollStreak = 0;
      this._schedulePoll();
    } catch (error) {
      if (error.httpStatus === 404 || error.code === 10_006) {
        this.pollStreak = 0;
        if (!this.claiming) {
          this.emit('drop', { source: 'poll', guildId: this.snipeGuildId, oldVanity: this.vanity, newVanity: null });
          void this.claim();
        }
        this._schedulePoll();
        return;
      }

      this.pollStreak += 1;
      if (this.pollStreak >= 5) {
        this.pollStreak = 0;
        this.pollCooldownUntil = Date.now() + 300_000;
        this._debug('poll circuit breaker - cooldown 5 min');
        this.emit('pollBreak', { status: error.httpStatus ?? 0, code: error.code ?? null });
      }
      this._schedulePoll(this.pollIntervalMs * 2);
    }
  }

  _debug(message) {
    this.client.emit('debug', `[VanitySniper /${this.vanity}] ${message}`);
  }
}

/**
 * Emitted when the sniper starts watching the origin guild.
 * @event VanitySniper#watching
 * @param {Object} info The watch information
 * @param {string} info.vanity The vanity code being watched
 * @param {Snowflake} info.snipeGuildId The guild holding the vanity
 * @param {Snowflake} info.claimGuildId The guild where the vanity will be claimed
 * @param {boolean} info.armed Whether the vanity has already been observed on the origin guild
 */

/**
 * Emitted when the watched vanity is detected as released.
 * @event VanitySniper#drop
 * @param {Object} drop The drop information
 * @param {string} drop.source Where the drop was detected (`gateway` or `poll`)
 * @param {Snowflake} drop.guildId The origin guild
 * @param {?string} drop.oldVanity The previous vanity code
 * @param {?string} drop.newVanity The new vanity code, if any
 */

/**
 * Emitted when the vanity has been claimed on the claim guild.
 * @event VanitySniper#claimed
 * @param {VanitySnipResult} result The claim result
 */

/**
 * Emitted when a claim attempt failed.
 * @event VanitySniper#claimFailed
 * @param {VanitySnipResult} result The claim result
 */

/**
 * Emitted when invite polling hit its repeated-failure circuit breaker.
 * @event VanitySniper#pollBreak
 * @param {Object} info The breaker information
 * @param {number} info.status The last HTTP status
 * @param {?number} info.code The last Discord error code
 */

module.exports = VanitySniper;
