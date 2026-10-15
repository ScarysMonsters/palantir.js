'use strict';

const Base = require('./Base');

/**
 * Represents a cached interaction response.
 * @extends {Base}
 */
class InteractionResponse extends Base {
  constructor(client, data) {
    super(client);

    if (data) this._patch(data);
  }

  _patch(data) {
    /**
     * The interaction id
     * @type {?Snowflake}
     */
    this.id = data.id ?? this.id ?? null;

    /**
     * The interaction type
     * @type {?number}
     */
    this.type = data.type ?? this.type ?? null;

    /**
     * The response data
     * @type {?Object}
     */
    this.data = data.data ?? this.data ?? null;

    /**
     * The id of the channel the interaction was sent in
     * @type {?Snowflake}
     */
    this.channelId = data.channelId ?? this.channelId ?? null;

    /**
     * The id of the guild the interaction was sent in
     * @type {?Snowflake}
     */
    this.guildId = data.guildId ?? this.guildId ?? null;

    return this;
  }
}

module.exports = InteractionResponse;
