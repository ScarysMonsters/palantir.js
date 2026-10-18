'use strict';

const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-discord-mfa-authorization',
  'x-captcha-key',
  'x-captcha-session-id',
  'x-captcha-rqtoken',
  'cookie',
]);

const SENSITIVE_JSON_KEYS = new Set(['token', 'password', 'totp', 'totpKey', 'authorization', 'secret', 'apiToken', 'mfaToken']);

const AUTH_PATH_PATTERN = /(^|\/)(auth|mfa)(\/|$)/;

/**
 * Strips secrets from headers before they are attached to an error object.
 * @param {Object} headers Raw request headers
 * @returns {Object} A copy with secret values replaced
 */
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const copy = {};
  for (const [key, value] of Object.entries(headers)) {
    copy[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return copy;
}

/**
 * Deep-copies a JSON payload, replacing values of sensitive keys. Keys that may
 * hold credentials nested inside arrays (multipart payloads) are covered too.
 * @param {*} data Raw JSON body
 * @param {number} [depth] Current recursion depth (up to 8 levels)
 * @returns {*} A sanitized copy
 */
function sanitizeJSON(data, depth = 0) {
  if (data === null || typeof data !== 'object') return data;
  if (depth > 8) return '[TRUNCATED]';
  const copy = Array.isArray(data) ? [] : {};
  for (const [key, value] of Object.entries(data)) {
    const sensitive = SENSITIVE_JSON_KEYS.has(key) || SENSITIVE_JSON_KEYS.has(key.charAt(0).toUpperCase() + key.slice(1));
    copy[key] = sensitive ? REDACTED : sanitizeJSON(value, depth + 1);
  }
  return copy;
}

/**
 * Builds a secret-free snapshot of the request that caused an error
 * (`DiscordAPIError#requestData` / `HTTPError#requestData`).
 *
 * - `Authorization`, MFA and captcha headers are redacted.
 * - Payloads of `auth/*` and `mfa/*` routes are dropped entirely (they contain
 *   emails, passwords and TOTP codes).
 * - Sensitive keys anywhere else (`token`, `password`, ...) are redacted.
 * @param {Object} request The failed request metadata (`method`, `path`, `options`)
 * @returns {Object} `{ json, files, headers }`
 */
function sanitizeRequestData(request) {
  const options = request.options ?? {};
  const isAuthRoute = typeof request.path === 'string' && AUTH_PATH_PATTERN.test(request.path);
  return {
    json: isAuthRoute ? undefined : sanitizeJSON(options.data),
    files: options.files ?? [],
    headers: sanitizeHeaders(options.headers),
  };
}

module.exports = sanitizeRequestData;
module.exports.sanitizeHeaders = sanitizeHeaders;
module.exports.sanitizeJSON = sanitizeJSON;
