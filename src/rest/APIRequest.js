'use strict';

const { Buffer } = require('node:buffer');
const { setTimeout } = require('node:timers');
const Util = require('../util/Util');

/**
 * Converts any supported file source (Buffer, Node stream, web ReadableStream, Blob) into a Blob.
 * Bun native `FormData` only accepts strings and Blobs.
 * @param {*} source The file source
 * @returns {Promise<Blob>}
 */
async function fileToBlob(source) {
  if (source instanceof Blob) return source;
  if (Buffer.isBuffer(source)) return new Blob([source]);
  if (source instanceof ArrayBuffer) return new Blob([source]);
  if (ArrayBuffer.isView(source)) return new Blob([source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)]);
  if (typeof source === 'string') return new Blob([source]);
  if (typeof source === 'object' && typeof source.getReader === 'function') {
    // Web ReadableStream
    return new Response(source).blob();
  }
  if (typeof source === 'object' && (typeof source.on === 'function' || typeof source.pipe === 'function')) {
    // Node Readable stream
    const chunks = [];
    for await (const chunk of source) chunks.push(chunk);
    return new Blob(chunks);
  }
  return new Blob([String(source)]);
}

class APIRequest {
  constructor(rest, method, path, options) {
    this.rest = rest;
    this.client = rest.client;
    this.method = method;
    this.route = options.route;
    this.options = options;
    this.retries = 0;
    this.fullUserAgent = this.client.options.http.headers['User-Agent'];
    this.client.options.ws.properties.browser_user_agent = this.fullUserAgent;

    let queryString = '';
    if (options.query) {
      const query = Object.entries(options.query)
        .filter(([, value]) => value !== null && typeof value !== 'undefined')
        .flatMap(([key, value]) => (Array.isArray(value) ? value.map(v => [key, v]) : [[key, value]]));
      queryString = new URLSearchParams(query).toString();
    }
    this.path = `${path}${queryString && `?${queryString}`}`;
  }

  // Resolves the proxy to use for this request, if any.
  _resolveProxy() {
    const data = Util.checkUndiciProxyAgent(this.client.options.http.agent);
    if (!data) return undefined;
    return data.uri;
  }

  async make(captchaKey, captchaRqToken) {
    const API =
      this.options.versioned === false
        ? this.client.options.http.api
        : `${this.client.options.http.api}/v${this.client.options.http.version}`;
    const url = API + this.path;

    let headers = {
      accept: '*/*',
      'accept-language': 'en-US',
      priority: 'u=1, i',
      referer: 'https://discord.com/channels/@me',
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'x-discord-locale': 'en-US',
      'x-discord-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      'x-super-properties': `${Buffer.from(JSON.stringify(this.client.options.ws.properties), 'ascii').toString(
        'base64',
      )}`,
      origin: 'https://discord.com',
      'x-debug-options': 'bugReporterEnabled',
      ...this.client.options.http.headers,
      'User-Agent': this.fullUserAgent,
    };

    if (this.options.auth !== false) headers.Authorization = this.rest.getAuth();
    if (this.options.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(this.options.reason);
    if (this.options.headers) headers = Object.assign(headers, this.options.headers);

    // Delete all headers if undefined
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) delete headers[key];
    }
    if (this.options.webhook === true) {
      headers = {
        'User-Agent': this.client.options.http.headers['User-Agent'],
      };
    }

    // Some options
    if (this.options.DiscordContext) {
      headers['X-Context-Properties'] = Buffer.from(JSON.stringify(this.options.DiscordContext), 'utf8').toString(
        'base64',
      );
    }

    if (this.options.mfaToken) {
      headers['X-Discord-Mfa-Authorization'] = this.options.mfaToken;
    }

    // Captcha
    if (captchaKey && typeof captchaKey == 'string') headers['X-Captcha-Key'] = captchaKey;
    if (captchaRqToken && typeof captchaRqToken == 'string') headers['X-Captcha-Rqtoken'] = captchaRqToken;

    let body;
    if (this.options.files?.length) {
      body = new FormData();
      for (const [index, file] of this.options.files.entries()) {
        if (file?.file) {
          const blob = await fileToBlob(file.file);
          body.append(file.key ?? `files[${index}]`, blob, file.name);
        }
      }
      if (typeof this.options.data !== 'undefined') {
        if (this.options.dontUsePayloadJSON) {
          for (const [key, value] of Object.entries(this.options.data)) {
            body.append(key, typeof value === 'object' ? JSON.stringify(value) : value);
          }
        } else {
          body.append('payload_json', JSON.stringify(this.options.data));
        }
      }
      // eslint-disable-next-line eqeqeq
    } else if (this.options.data != null) {
      if (this.options.usePayloadJSON) {
        body = new FormData();
        body.append('payload_json', JSON.stringify(this.options.data));
      } else {
        body = JSON.stringify(this.options.data);
        headers['Content-Type'] = 'application/json';
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.client.options.restRequestTimeout).unref();
    const proxy = this._resolveProxy();
    if (proxyUnsupported(proxy, this.client.options.http.transport)) {
      clearTimeout(timeout);
      const { Error: DJSError } = require('../errors');
      throw new DJSError('PROXY_NOT_SUPPORTED');
    }
    return this.rest
      .fetch(url, {
        method: this.method.toUpperCase(),
        headers,
        body,
        signal: controller.signal,
        redirect: 'follow',
        proxy,
        credentials: 'include',
      })
      .finally(() => clearTimeout(timeout));
  }
}

/**
 * A configured proxy is only honored through Bun's `fetch` (`proxy` option) or
 * the Chrome transport (its own `CONNECT` tunneling). Under Node with the
 * native transport the proxy would be silently ignored and the real IP would
 * leak — the request must fail instead.
 * @param {?string} proxyUri Resolved proxy URI, if any
 * @param {string} transport Configured `http.transport`
 * @returns {boolean}
 */
function proxyUnsupported(proxyUri, transport) {
  return Boolean(proxyUri) && transport !== 'chrome' && !process.versions.bun;
}

module.exports = APIRequest;
module.exports.proxyUnsupported = proxyUnsupported;
