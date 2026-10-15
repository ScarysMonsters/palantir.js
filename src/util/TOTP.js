'use strict';

const crypto = require('node:crypto');

/**
 * Decodes an RFC 4648 base32 string into a Buffer.
 * @param {string} input The base32 string
 * @returns {Buffer}
 */
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * Generates a TOTP code, RFC 6238.
 * @param {string} secret The base32-encoded secret
 * @param {Object} [options] Generator options
 * @param {number} [options.step=30] Time step in seconds
 * @param {number} [options.digits=6] Amount of digits
 * @param {string} [options.algorithm='sha1'] HMAC algorithm
 * @param {string} [options.encoding='base32'] Secret encoding
 * @returns {string}
 */
function generateTOTP(secret, options = {}) {
  const { step = 30, digits = 6, algorithm = 'sha1', encoding = 'base32', epoch } = options;
  if (encoding !== 'base32') throw new Error(`Unsupported TOTP encoding: ${encoding}`);
  const key = base32Decode(secret);
  const counter = Math.floor((epoch ?? Date.now() / 1_000) / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algorithm, key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/*
 * Drop-in replacement for the `otplib` authenticator used by the client.
 */
const authenticator = {
  options: {
    step: 30,
    digits: 6,
    algorithm: 'sha1',
    encoding: 'base32',
  },
  /**
   * @param {string} secret The base32-encoded secret
   * @returns {string}
   */
  generate(secret) {
    return generateTOTP(secret, this.options);
  },
  /**
   * @param {Object} options Options to merge into the current options
   * @returns {void}
   */
  setOptions(options) {
    this.options = { ...this.options, ...options };
  },
};

module.exports = { authenticator, generateTOTP, base32Decode };
