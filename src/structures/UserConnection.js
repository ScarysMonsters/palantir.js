'use strict';

/**
 * Represents a connected account of the current user (external service account
 * linked to Discord: Twitch, Steam, Spotify, Reddit, contacts, ...).
 * @see {@link https://discord-userdoccers.vercel.app/resources/connected-accounts#connection-object}
 */
class UserConnection {
  constructor(client, data) {
    Object.defineProperty(this, 'client', { value: client });
    if (data) this._patch(data);
  }

  /**
   * ID of the connection account
   * @type {?string}
   */
  id = null;

  /**
   * The type of the connection (`twitch`, `steam`, `spotify`, `reddit`, ...)
   * @type {?string}
   */
  type = null;

  /**
   * The username of the connection account
   * @type {?string}
   */
  name = null;

  /**
   * Whether the connection is verified
   * @type {boolean}
   */
  verified = false;

  /**
   * Whether the connection has been revoked
   * @type {boolean}
   */
  revoked = false;

  /**
   * Whether friend sync is enabled for this connection
   * @type {boolean}
   */
  friendSync = false;

  /**
   * Whether activities related to this connection are shown in presence
   * @type {boolean}
   */
  showActivity = false;

  /**
   * Whether this connection has a corresponding third party OAuth2 token
   * @type {boolean}
   */
  twoWayLink = false;

  /**
   * Visibility of the connection (`0` for private, `1` for visible to everyone)
   * @type {number}
   */
  visibility = 0;

  /**
   * Visibility of the connection's metadata (`0` or `1`)
   * @type {number}
   */
  metadataVisibility = 0;

  /**
   * Service-specific metadata about the connection
   * @type {?Object}
   */
  metadata = null;

  /**
   * The access token for the connection account, if available
   * @type {?string}
   */
  accessToken = null;

  /**
   * The guild integrations attached to this connection
   * @type {?Array<Object>}
   */
  integrations = null;

  _patch(data) {
    if ('id' in data) this.id = data.id;
    if ('type' in data) this.type = data.type;
    if ('name' in data) this.name = data.name;
    if ('verified' in data) this.verified = data.verified ?? false;
    if ('revoked' in data) this.revoked = data.revoked ?? false;
    if ('friend_sync' in data) this.friendSync = data.friend_sync ?? false;
    if ('show_activity' in data) this.showActivity = data.show_activity ?? false;
    if ('two_way_link' in data) this.twoWayLink = data.two_way_link ?? false;
    if ('visibility' in data) this.visibility = data.visibility ?? 0;
    if ('metadata_visibility' in data) this.metadataVisibility = data.metadata_visibility ?? 0;
    if ('metadata' in data) this.metadata = data.metadata;
    if ('access_token' in data) this.accessToken = data.access_token;
    if ('integrations' in data) this.integrations = data.integrations;
    return this;
  }

  /**
   * The raw API data for this connection
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      verified: this.verified,
      revoked: this.revoked,
      friend_sync: this.friendSync,
      show_activity: this.showActivity,
      two_way_link: this.twoWayLink,
      visibility: this.visibility,
      metadata_visibility: this.metadataVisibility,
      metadata: this.metadata,
      access_token: this.accessToken ?? undefined,
      integrations: this.integrations ?? undefined,
    };
  }

  toString() {
    return this.name ?? '';
  }
}

module.exports = UserConnection;
