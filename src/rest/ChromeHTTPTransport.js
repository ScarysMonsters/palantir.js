'use strict';

const { Buffer } = require('node:buffer');
const { randomBytes } = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');
const { ciphers } = require('../util/Constants');

const MAX_REDIRECTS = 5;
const MAX_BODY = 100 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let sharedAgent = null;

function getAgent() {
  if (sharedAgent) return sharedAgent;
  // Chrome cipher suites in the exact order Chrome offers them. This mirrors
  // what djs-selfbot-v13 achieves through undici's `buildConnector`, but with a
  // zero-dependency `node:https` implementation that Bun's node-compat layer
  // honors (verified: the resulting JA3 differs from the default runtime's).
  sharedAgent = new https.Agent({
    ciphers: ciphers.join(':'),
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 40,
    scheduling: 'lifo',
  });
  return sharedAgent;
}

/**
 * A minimal buffered response object exposing the subset of the fetch `Response`
 * API the REST manager relies on (`ok`, `status`, `statusText`, `headers`, clone,
 * text, json, arrayBuffer, blob).
 */
class ChromeResponse {
  constructor(status, statusText, rawHeaders, body, url) {
    this.status = status;
    this.statusText = statusText ?? '';
    this.body = body;
    this.url = url ?? '';
    const entries = [];
    for (let i = 0; i < rawHeaders.length; i += 2) entries.push([rawHeaders[i], rawHeaders[i + 1]]);
    this.headers = new Headers(entries);
  }

  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  clone() {
    return new ChromeResponse(this.status, this.statusText, this.headersToRaw(), this.body, this.url);
  }

  headersToRaw() {
    const flat = [];
    for (const [key, value] of this.headers.entries()) {
      flat.push(key, value);
    }
    return flat;
  }

  async arrayBuffer() {
    return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.byteLength);
  }

  async blob() {
    return new Blob([this.body]);
  }

  async text() {
    return this.body.toString('utf8');
  }

  async json() {
    return JSON.parse(this.body.toString('utf8'));
  }
}

/**
 * Multipart serialization for native `FormData` payloads (rest requests with files).
 * @param {FormData} formData
 * @returns {Promise<{ body: Buffer, contentType: string }>}
 */
async function serializeFormData(formData) {
  const boundary = `----WebKitFormBoundary${randomBytes(16).toString('hex')}`;
  const chunks = [];
  const push = (...parts) => chunks.push(Buffer.from(parts.join(''), 'utf8'));

  for (const [name, value] of formData.entries()) {
    push(`--${boundary}\r\n`);
    if (typeof value === 'string') {
      push(
        `content-disposition: form-data; name="${name}"\r\n`,
        `content-type: text/plain; charset=UTF-8\r\n\r\n`,
        value,
        '\r\n',
      );
      continue;
    }
    const filename = value.name ?? 'blob';
    push(
      `content-disposition: form-data; name="${name}"; filename="${filename.replace(/[^\w.\-]/g, '_')}"\r\n`,
      `content-type: ${value.type || 'application/octet-stream'}\r\n\r\n`,
    );
    chunks.push(Buffer.from(await value.arrayBuffer()));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Decompresses a response body based on the `content-encoding` header.
 * @param {Buffer} body
 * @param {?string} encoding
 * @returns {Promise<Buffer>}
 */
function decompressBody(body, encoding) {
  switch ((encoding ?? '').toLowerCase().trim().split(',')[0]) {
    case 'gzip':
      return zlib.gunzipSync(body);
    case 'deflate': {
      try {
        return zlib.inflateSync(body);
      } catch {
        // Some servers send a raw deflate stream without zlib framing.
        return zlib.inflateRawSync(body);
      }
    }
    case 'br':
      return zlib.brotliDecompressSync(body);
    default:
      return body;
  }
}

/**
 * Establishes a TLS tunnel through an HTTP `CONNECT` proxy.
 * @param {URL} proxyUrl
 * @param {string} host Target host and port, formatted `host:port`
 * @returns {Promise<import('net').Socket>}
 */
function proxyConnect(proxyUrl, host) {
  return new Promise((resolve, reject) => {
    const isHttps = proxyUrl.protocol === 'https:';
    const port = proxyUrl.port || (isHttps ? 443 : 80);
    const connectModule = isHttps ? https : http;
    let closed = false;
    const request = connectModule.request(
      {
        host: proxyUrl.hostname,
        port,
        method: 'CONNECT',
        path: host,
        headers: proxyUrl.username ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password ?? '')}`).toString('base64') } : {},
        timeout: 15_000,
      },
      response => {
        if (closed) return;
        if (response.statusCode !== 200) {
          closed = true;
          reject(new Error(`PROXY_TUNNEL_FAILED_${response.statusCode}`));
        }
      },
    );
    request.on('connect', (response, socket) => {
      if (closed) {
        socket.destroy();
        return;
      }
      closed = true;
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`PROXY_TUNNEL_FAILED_${response.statusCode}`));
        return;
      }
      clearTimeout(request.timeout);
      resolve(socket);
    });
    request.on('timeout', () => {
      if (!closed) {
        closed = true;
        request.destroy();
        reject(new Error('PROXY_TUNNEL_TIMEOUT'));
      }
    });
    request.on('error', error => {
      if (!closed) {
        closed = true;
        reject(error);
      }
    });
    request.end();
  });
}

function abortError() {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERROR';
  return error;
}

/**
 * Performs a single HTTP request (no redirects) and returns a buffered response.
 * @param {URL} url
 * @param {Object} options
 * @param {?import('net').Socket} [socket] An established connected socket (proxy tunnel)
 * @returns {Promise<ChromeResponse>}
 */
function requestOnce(url, options, socket = null) {
  const isHttps = url.protocol === 'https:';
  const { headers, bodyBuffer, signal } = options;
  const port = url.port || (isHttps ? 443 : 80);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const requestModule = isHttps ? https : http;
    // node:http iterates the headers object's own enumerable properties — a `Headers`
    // instance must be flattened to a plain record first.
    const headerRecord = {};
    if (headers instanceof Headers) {
      for (const [key, value] of headers.entries()) headerRecord[key] = value;
    } else {
      for (const [key, value] of Object.entries(headers ?? {})) {
        headerRecord[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    const requestOptions = {
      host: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: headerRecord,
    };
    if (socket) {
      requestOptions.socket = socket;
      requestOptions.agent = false;
    } else if (isHttps) {
      requestOptions.agent = getAgent();
    }

    let settled = false;
    const onAbort = () =>
      settle(() => {
        request.destroy();
        reject(abortError());
      });
    const settle = callback => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback();
    };

    const request = requestModule.request(requestOptions, response => {
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status) && response.headers.location) {
        response.resume();
        settle(() => resolve({ redirect: response.headers.location, status }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) {
          request.destroy();
          settle(() => reject(new Error('RESPONSE_TOO_LARGE')));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () =>
        settle(() => {
          const body = decompressBody(Buffer.concat(chunks), response.headers['content-encoding']);
          resolve(new ChromeResponse(status, response.statusMessage, response.rawHeaders, body, url.toString()));
        }),
      );
      response.on('error', error =>
        settle(() => {
          request.destroy();
          reject(error);
        }),
      );
    });

    request.on('error', error => settle(() => reject(error)));

    signal?.addEventListener('abort', onAbort, { once: true });

    if (bodyBuffer) request.write(bodyBuffer);
    request.end();
  });
}

/**
 * Follows redirects (max 5) and returns the final response.
 * @param {string|URL} url
 * @param {Object} options
 * @returns {Promise<ChromeResponse>}
 */
async function fetch(url, options = {}) {
  let target = url instanceof URL ? new URL(url.toString()) : new URL(url);
  options.method = (options.method ?? 'GET').toUpperCase();

  let bodyBuffer;
  let extraHeaders = {};
  if (options.body instanceof FormData) {
    const serialized = await serializeFormData(options.body);
    bodyBuffer = serialized.body;
    extraHeaders['content-type'] = serialized.contentType;
  } else if (options.body instanceof Blob) {
    bodyBuffer = Buffer.from(await options.body.arrayBuffer());
  } else if (options.body instanceof ArrayBuffer) {
    bodyBuffer = Buffer.from(options.body);
  } else if (ArrayBuffer.isView(options.body)) {
    bodyBuffer = Buffer.from(options.body.buffer, options.body.byteOffset, options.body.byteLength);
  } else if (typeof options.body === 'string') {
    bodyBuffer = Buffer.from(options.body, 'utf8');
  } else if (options.body != null) {
    bodyBuffer = Buffer.from(String(options.body), 'utf8');
  }

  const transportOptions = {
    method: options.method,
    headers: options.headers ?? new Headers(),
    bodyBuffer,
    signal: options.signal ?? null,
  };
  if (extraHeaders['content-type']) transportOptions.headers.set('content-type', extraHeaders['content-type']);
  let transportSocket = null;
  if (options.proxy) {
    const proxyUrl = new URL(options.proxy);
    const host = `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`;
    transportSocket = await proxyConnect(proxyUrl, host);
  }

  try {
    let redirectCount = 0;
    for (;;) {
      const result = await requestOnce(target, transportOptions, transportSocket);
      if (result.redirect) {
        redirectCount += 1;
        if (redirectCount > MAX_REDIRECTS) throw new Error('MAX_REDIRECTS_EXCEEDED');
        if (result.status === 303 || ((result.status === 301 || result.status === 302) && transportOptions.method === 'POST')) {
          transportOptions.method = 'GET';
          transportOptions.bodyBuffer = undefined;
        }
        target = new URL(result.redirect, target);
        continue;
      }
      return result;
    }
  } finally {
    // Per-request proxy sockets are not pooled: destroy them once the response
    // has been fully read to avoid leaking file descriptors.
    transportSocket?.destroy();
  }
}

module.exports = { fetch, ChromeResponse };
