'use strict';

const DiscordAPIError = require('./DiscordAPIError');

/**
 * Represents a request blocked by Cloudflare before it reached the Discord API
 * (HTTP 403 with the JSON error code `40333`). These blocks are usually tied to
 * the IP address or the user agent rather than the account, and last for a
 * while — pause sending requests instead of retrying.
 * @extends DiscordAPIError
 */
class CloudflareBanError extends DiscordAPIError {
  constructor(error, status, request) {
    super(error, status, request);

    /**
     * The name of the error
     * @type {string}
     */
    this.name = 'CloudflareBanError';
  }
}

module.exports = CloudflareBanError;
