'use strict';

/**
 * Minimal cookie jar. Zero dependency replacement for `tough-cookie` + `fetch-cookie`.
 */
class CookieJar {
  constructor() {
    this.cookies = [];
  }

  /**
   * Stores a `Set-Cookie` header value for the given URL.
   * @param {string} cookieString The raw `Set-Cookie` value
   * @param {string} url The URL the cookie originates from
   * @returns {void}
   */
  setCookie(cookieString, url) {
    const urlObj = new URL(url);
    const parts = cookieString.split(';');
    const [nameValue, ...attributes] = parts;
    const eqIndex = nameValue.indexOf('=');
    if (eqIndex === -1) return;
    const name = nameValue.slice(0, eqIndex).trim();
    const value = nameValue.slice(eqIndex + 1).trim();
    if (!name) return;

    const cookie = {
      name,
      value,
      domain: urlObj.hostname,
      path: '/',
      expires: null,
      secure: false,
      httpOnly: false,
    };

    for (const attribute of attributes) {
      const eq = attribute.indexOf('=');
      const key = (eq === -1 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
      const val = eq === -1 ? true : attribute.slice(eq + 1).trim();
      switch (key) {
        case 'domain':
          cookie.domain = String(val).replace(/^\./, '').toLowerCase();
          break;
        case 'path':
          cookie.path = String(val) || '/';
          break;
        case 'expires': {
          const date = new Date(String(val));
          if (!Number.isNaN(date.getTime())) cookie.expires = date.getTime();
          break;
        }
        case 'max-age': {
          const seconds = Number(val);
          if (!Number.isNaN(seconds)) cookie.expires = Date.now() + seconds * 1_000;
          break;
        }
        case 'secure':
          cookie.secure = true;
          break;
        case 'httponly':
          cookie.httpOnly = true;
          break;
      }
    }

    const index = this.cookies.findIndex(
      c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
    );
    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      if (index !== -1) this.cookies.splice(index, 1);
      return;
    }
    if (index !== -1) this.cookies[index] = cookie;
    else this.cookies.push(cookie);
  }

  /**
   * Returns the `Cookie` header value for the given URL, or `null` when there is no matching cookie.
   * @param {string} url The URL the request is sent to
   * @returns {?string}
   */
  getCookieString(url) {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    const path = urlObj.pathname || '/';
    const isSecure = urlObj.protocol === 'https:';
    const now = Date.now();
    const matched = this.cookies.filter(cookie => {
      if (cookie.expires !== null && cookie.expires <= now) return false;
      if (cookie.secure && !isSecure) return false;
      if (host !== cookie.domain && !host.endsWith(`.${cookie.domain}`)) return false;
      if (!path.startsWith(cookie.path)) return false;
      return true;
    });
    if (matched.length === 0) return null;
    return matched.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /**
   * Extracts cookies from a fetch `Response` and stores them.
   * @param {string} url The request URL
   * @param {Response} response The response
   * @returns {void}
   */
  storeFromResponse(url, response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) this.setCookie(cookie, url);
  }
}

module.exports = { CookieJar };
