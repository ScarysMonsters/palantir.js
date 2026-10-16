'use strict';

const { Collection } = require('../util/Collection');
const BaseManager = require('./BaseManager');
const UserConnection = require('../structures/UserConnection');

const keyOf = (type, id) => `${type}:${id}`;

/**
 * Manages the connected accounts (`/users/@me/connections`) of the logged in user.
 * @extends {BaseManager}
 * @see {@link https://discord-userdoccers.vercel.app/resources/connected-accounts}
 */
class UserConnectionManager extends BaseManager {
  constructor(client) {
    super(client);
    /**
     * The cache of this manager
     * @type {Collection<string, UserConnection>}
     */
    this.cache = new Collection();
  }

  /**
   * The cache of this manager indexed by `type:id`
   * @type {Collection<string, UserConnection>}
   * @name UserConnectionManager#cache
   */

  /**
   * Gets the cache key for a connection
   * @param {string} type The type of the connection
   * @param {string} id The id of the connection
   * @returns {string}
   */
  static keyOf(type, id) {
    return keyOf(type, id);
  }

  /**
   * Fetches the connections of the current user.
   * @returns {Promise<Collection<string, UserConnection>>}
   */
  async fetch() {
    const data = await this.client.api.users['@me'].connections.get();
    this.cache = new Collection(data.map(connection => [keyOf(connection.type, connection.id), new UserConnection(this.client, connection)]));
    return this.cache;
  }

  /**
   * Fetches a single connection of the current user.
   * @param {string} type The type of the connection
   * @param {string} id The id of the connection
   * @returns {Promise<UserConnection>}
   */
  async fetchConnection(type, id) {
    const data = await this.client.api.users['@me'].connections[type][id].get();
    const connection = new UserConnection(this.client, data);
    this.cache.set(keyOf(data.type ?? type, data.id ?? id), connection);
    return connection;
  }

  /**
   * Modifies the settings of a connection of the current user.
   * @param {string} type The type of the connection
   * @param {string} id The id of the connection
   * @param {UserConnectionsEditOptions} options The modification to apply
   * @returns {Promise<UserConnection>}
   */
  async edit(type, id, options = {}) {
    const data = await this.client.api.users['@me'].connections[type][id].patch({
      data: {
        friend_sync: options.friendSync,
        show_activity: options.showActivity,
        two_way_link: options.twoWayLink,
        visibility: options.visibility,
        metadata_visibility: options.metadataVisibility,
      },
    });
    const connection = new UserConnection(this.client, data);
    this.cache.set(keyOf(type, id), connection);
    return connection;
  }

  /**
   * Deletes a connection of the current user.
   * @param {string} type The type of the connection
   * @param {string} id The id of the connection
   * @returns {Promise<void>}
   */
  async delete(type, id) {
    await this.client.api.users['@me'].connections[type][id].delete();
    this.cache.delete(keyOf(type, id));
  }

  /**
   * Refreshes the metadata of a connection of the current user.
   * @param {string} type The type of the connection
   * @param {string} id The id of the connection
   * @returns {Promise<Collection<string, UserConnection>>} The refreshed connections
   */
  async refresh(type, id) {
    await this.client.api.users['@me'].connections[type][id].refresh.post();
    return this.fetch();
  }

  /**
   * Builds a new OAuth2 access token for a connection.
   * @param {string} type The type of the connection
   * @param {string} id The id of the connection
   * @returns {Promise<Object<"access_token", string>>} The created access token
   */
  async buildAccessToken(type, id) {
    return this.client.api.users['@me'].connections[type][id]['access-token'].get();
  }

  /**
   * Requests an authorization link for a new connection of the given type.
   * @param {string} type The type of the connection
   * @returns {Promise<Object<"url", string>>}
   */
  async authorizeLink(type) {
    return this.client.api.connections[type].authorize.get();
  }

  /**
   * Fetches the subreddits of a `reddit` connection, for choosing which
   * subreddits to friend-sync.
   * @param {string} id The id of the connection
   * @returns {Promise<Array<Object>>}
   */
  async fetchRedditSubscribableSubreddits(id) {
    return this.client.api.users['@me'].connections.reddit[id].subreddits.get();
  }

  /**
   * Marks a domain connection (`email`-type merchants) as valid,
   * confirming domain ownership.
   * @param {string} id The id of the connection
   * @returns {Promise<UserConnection>}
   */
  async verifyDomain(id) {
    const data = await this.client.api.users['@me'].connections.domain[id].post();
    const connection = new UserConnection(this.client, data);
    this.cache.set(keyOf(connection.type ?? 'domain', data.id ?? id), connection);
    return connection;
  }
}

/**
 * @typedef {Object} UserConnectionsEditOptions
 * @property {boolean} [friendSync] Whether friend sync should be enabled
 * @property {boolean} [showActivity] Whether activities related to this connection should be shown in presence
 * @property {boolean} [twoWayLink] Whether a corresponding third party OAuth2 token should exist
 * @property {number} [visibility] Visibility of the connection (`0` private, `1` visible to everyone)
 * @property {number} [metadataVisibility] Visibility of the connection's metadata (`0` or `1`)
 */

module.exports = UserConnectionManager;
