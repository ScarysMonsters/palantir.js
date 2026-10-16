'use strict';

const { setInterval } = require('node:timers');
const { Collection } = require('../util/Collection');
const { CookieJar } = require('./CookieJar');
const APIRequest = require('./APIRequest');
const routeBuilder = require('./APIRouter');
const RequestHandler = require('./RequestHandler');
const ChromeHTTPTransport = require('./ChromeHTTPTransport');
const { Error } = require('../errors');
const { Endpoints } = require('../util/Constants');

class RESTManager {
  constructor(client) {
    this.client = client;
    this.handlers = new Collection();
    this.versioned = true;
    this.globalLimit = client.options.restGlobalRateLimit > 0 ? client.options.restGlobalRateLimit : Infinity;
    this.globalRemaining = this.globalLimit;
    this.globalReset = null;
    this.globalDelay = null;
    this.cookieJar = new CookieJar();
    // Cookie-aware fetch wrapping either the native fetch or the Chrome-cipher
    // transport (zero dependency replacement for `fetch-cookie` + `tough-cookie` +
    // `undici`).
    this.fetch = async (url, options = {}) => {
      const headers = new Headers(options.headers ?? {});
      const cookie = this.cookieJar.getCookieString(url);
      if (cookie) headers.set('cookie', cookie);
      const response =
        client.options.http.transport === 'chrome'
          ? await ChromeHTTPTransport.fetch(url, { ...options, headers })
          : await fetch(url, { ...options, headers });
      this.cookieJar.storeFromResponse(url, response);
      return response;
    };
    if (client.options.restSweepInterval > 0) {
      this.sweepInterval = setInterval(() => {
        this.handlers.sweep(handler => handler._inactive);
      }, client.options.restSweepInterval * 1_000).unref();
    }
  }

  get api() {
    return routeBuilder(this);
  }

  getAuth() {
    const token = this.client.token ?? this.client.accessToken;
    if (token) return token.replace(/^(Bot|Bearer)\s+/i, '');
    throw new Error('TOKEN_MISSING');
  }

  get cdn() {
    return Endpoints.CDN(this.client.options.http.cdn);
  }

  request(method, url, options = {}) {
    const apiRequest = new APIRequest(this, method, url, options);
    let handler = this.handlers.get(apiRequest.route);

    if (!handler) {
      handler = new RequestHandler(this);
      this.handlers.set(apiRequest.route, handler);
    }

    return handler.push(apiRequest);
  }

  get endpoint() {
    return this.client.options.http.api;
  }

  set endpoint(endpoint) {
    this.client.options.http.api = endpoint;
  }
}

module.exports = RESTManager;
