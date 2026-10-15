'use strict';

/**
 * palantir.js — zero required dependency, Bun-native Discord selfbot library.
 *
 * Every export is loaded lazily on first access so requiring the package is (nearly) free.
 */

const lazyRequire = pathStr => {
  let cached;
  return () => (cached ??= require(pathStr));
};

const defineExport = (name, factory) => {
  Object.defineProperty(exports, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = factory();
      Object.defineProperty(exports, name, { value, enumerable: true, configurable: true, writable: true });
      return value;
    },
  });
};

const defineModule = (name, pathStr) => defineExport(name, lazyRequire(pathStr));
const defineMember = (name, pathStr, prop) => defineExport(name, () => lazyRequire(pathStr)()[prop]);

// "Root" classes (starting points)
defineModule('BaseClient', './client/BaseClient');
defineModule('Client', './client/Client');
/* @deprecated This will be removed in the next major version */
defineModule('Shard', './sharding/Shard');
/* @deprecated This will be removed in the next major version */
defineModule('ShardClientUtil', './sharding/ShardClientUtil');
/* @deprecated This will be removed in the next major version */
defineModule('ShardingManager', './sharding/ShardingManager');
defineModule('WebhookClient', './client/WebhookClient');

defineModule('ActivityFlags', './util/ActivityFlags');
defineModule('ApplicationFlags', './util/ApplicationFlags');
defineModule('AttachmentFlags', './util/AttachmentFlags');

// Utilities
defineModule('BaseManager', './managers/BaseManager');
defineModule('BitField', './util/BitField');
defineMember('Collection', './util/Collection', 'Collection');
defineModule('Constants', './util/Constants');
defineModule('DataResolver', './util/DataResolver');
defineModule('DiscordAPIError', './rest/DiscordAPIError');
defineModule('Formatters', './util/Formatters');
defineModule('GuildMemberFlags', './util/GuildMemberFlags');
defineModule('HTTPError', './rest/HTTPError');
defineModule('Intents', './util/Intents');
defineModule('LimitedCollection', './util/LimitedCollection');
defineModule('MessageFlags', './util/MessageFlags');
defineModule('Options', './util/Options');
defineModule('NoneCap', './util/NoneCap');
defineModule('Permissions', './util/Permissions');
defineModule('RateLimitError', './rest/RateLimitError');
defineModule('RoleFlags', './util/RoleFlags');
defineModule('SnowflakeUtil', './util/SnowflakeUtil');
defineModule('Sweepers', './util/Sweepers');
defineModule('SystemChannelFlags', './util/SystemChannelFlags');
defineModule('ThreadMemberFlags', './util/ThreadMemberFlags');
defineModule('UserFlags', './util/UserFlags');
defineModule('Util', './util/Util');
exports.version = require('../package.json').version;

// Managers
defineModule('ApplicationCommandManager', './managers/ApplicationCommandManager');
defineModule('ApplicationCommandPermissionsManager', './managers/ApplicationCommandPermissionsManager');
defineModule('AutoModerationRuleManager', './managers/AutoModerationRuleManager');
defineModule('BaseGuildEmojiManager', './managers/BaseGuildEmojiManager');
defineModule('CachedManager', './managers/CachedManager');
defineModule('ChannelManager', './managers/ChannelManager');
defineModule('ClientVoiceManager', './client/voice/ClientVoiceManager');
defineModule('VoiceSession', './client/voice/VoiceSession');
defineModule('DataManager', './managers/DataManager');
defineModule('GuildBanManager', './managers/GuildBanManager');
defineModule('GuildChannelManager', './managers/GuildChannelManager');
defineModule('GuildEmojiManager', './managers/GuildEmojiManager');
defineModule('GuildEmojiRoleManager', './managers/GuildEmojiRoleManager');
defineModule('GuildInviteManager', './managers/GuildInviteManager');
defineModule('GuildJoinRequestManager', './managers/GuildJoinRequestManager');
defineModule('GuildManager', './managers/GuildManager');
defineModule('GuildMemberManager', './managers/GuildMemberManager');
defineModule('GuildMemberRoleManager', './managers/GuildMemberRoleManager');
defineModule('GuildScheduledEventManager', './managers/GuildScheduledEventManager');
defineModule('GuildStickerManager', './managers/GuildStickerManager');
defineModule('MessageManager', './managers/MessageManager');
defineModule('PermissionOverwriteManager', './managers/PermissionOverwriteManager');
defineModule('PresenceManager', './managers/PresenceManager');
defineModule('ReactionManager', './managers/ReactionManager');
defineModule('ReactionUserManager', './managers/ReactionUserManager');
defineModule('RoleManager', './managers/RoleManager');
defineModule('SessionManager', './managers/SessionManager');
defineModule('StageInstanceManager', './managers/StageInstanceManager');
defineModule('ThreadManager', './managers/ThreadManager');
defineModule('ThreadMemberManager', './managers/ThreadMemberManager');
defineModule('UserManager', './managers/UserManager');
defineModule('VoiceStateManager', './managers/VoiceStateManager');
defineModule('WebSocketManager', './client/websocket/WebSocketManager');
defineModule('WebSocketShard', './client/websocket/WebSocketShard');
defineModule('RelationshipManager', './managers/RelationshipManager');
defineModule('UserNoteManager', './managers/UserNoteManager');
defineModule('QuestManager', './managers/QuestManager');
defineMember('Quest', './managers/QuestManager', 'Quest');
defineModule('BackupManager', './managers/BackupManager');

// Structures
defineMember('Activity', './structures/Presence', 'Activity');
defineModule('AnonymousGuild', './structures/AnonymousGuild');
defineModule('Application', './structures/interfaces/Application');
defineModule('ApplicationCommand', './structures/ApplicationCommand');
defineMember('ApplicationRoleConnectionMetadata', './structures/ApplicationRoleConnectionMetadata', 'ApplicationRoleConnectionMetadata');
defineModule('AutoModerationActionExecution', './structures/AutoModerationActionExecution');
defineModule('AutoModerationRule', './structures/AutoModerationRule');
defineModule('Base', './structures/Base');
defineModule('BaseGuild', './structures/BaseGuild');
defineModule('BaseGuildEmoji', './structures/BaseGuildEmoji');
defineModule('BaseGuildTextChannel', './structures/BaseGuildTextChannel');
defineModule('BaseGuildVoiceChannel', './structures/BaseGuildVoiceChannel');
defineModule('CategoryChannel', './structures/CategoryChannel');
defineMember('Channel', './structures/Channel', 'Channel');
defineModule('ClientPresence', './structures/ClientPresence');
defineModule('ClientUser', './structures/ClientUser');
defineModule('VanitySniper', './structures/VanitySniper');
defineModule('Collector', './structures/interfaces/Collector');
defineModule('DirectoryChannel', './structures/DirectoryChannel');
defineModule('DMChannel', './structures/DMChannel');
defineMember('Emoji', './structures/Emoji', 'Emoji');
defineModule('ForumChannel', './structures/ForumChannel');
defineMember('Guild', './structures/Guild', 'Guild');
defineModule('GuildJoinRequest', './structures/GuildJoinRequest');
defineModule('GuildAuditLogs', './structures/GuildAuditLogs');
defineMember('GuildAuditLogsEntry', './structures/GuildAuditLogs', 'Entry');
defineModule('GuildBan', './structures/GuildBan');
defineModule('GuildChannel', './structures/GuildChannel');
defineModule('GuildEmoji', './structures/GuildEmoji');
defineMember('GuildMember', './structures/GuildMember', 'GuildMember');
defineModule('GuildPreview', './structures/GuildPreview');
defineModule('GuildPreviewEmoji', './structures/GuildPreviewEmoji');
defineMember('GuildScheduledEvent', './structures/GuildScheduledEvent', 'GuildScheduledEvent');
defineModule('GuildTemplate', './structures/GuildTemplate');
defineModule('Integration', './structures/Integration');
defineModule('IntegrationApplication', './structures/IntegrationApplication');
defineModule('Invite', './structures/Invite');
defineModule('InviteStageInstance', './structures/InviteStageInstance');
defineModule('InviteGuild', './structures/InviteGuild');
defineModule('MediaChannel', './structures/MediaChannel');
defineMember('Message', './structures/Message', 'Message');
defineModule('MessageActionRow', './structures/MessageActionRow');
defineModule('MessageAttachment', './structures/MessageAttachment');
defineModule('MessageButton', './structures/MessageButton');
defineModule('MessageCollector', './structures/MessageCollector');
defineModule('MessageEmbed', './structures/MessageEmbed');
defineModule('MessageMentions', './structures/MessageMentions');
defineModule('MessagePayload', './structures/MessagePayload');
defineModule('MessageReaction', './structures/MessageReaction');
defineModule('Modal', './structures/Modal');
defineModule('NewsChannel', './structures/NewsChannel');
defineModule('OAuth2Guild', './structures/OAuth2Guild');
defineModule('GroupDMChannel', './structures/GroupDMChannel');
defineModule('PermissionOverwrites', './structures/PermissionOverwrites');
defineMember('Presence', './structures/Presence', 'Presence');
defineModule('ReactionCollector', './structures/ReactionCollector');
defineModule('ReactionEmoji', './structures/ReactionEmoji');
defineMember('RichPresenceAssets', './structures/Presence', 'RichPresenceAssets');
defineMember('Role', './structures/Role', 'Role');
defineModule('Session', './structures/Session');
defineModule('StageChannel', './structures/StageChannel');
defineMember('StageInstance', './structures/StageInstance', 'StageInstance');
defineMember('Sticker', './structures/Sticker', 'Sticker');
defineModule('StickerPack', './structures/StickerPack');
defineModule('StoreChannel', './structures/StoreChannel');
defineModule('Team', './structures/Team');
defineModule('TeamMember', './structures/TeamMember');
defineModule('TextChannel', './structures/TextChannel');
defineModule('TextInputComponent', './structures/TextInputComponent');
defineModule('ThreadChannel', './structures/ThreadChannel');
defineModule('ThreadOnlyChannel', './structures/ThreadOnlyChannel');
defineModule('ThreadMember', './structures/ThreadMember');
defineModule('Typing', './structures/Typing');
defineModule('User', './structures/User');
defineModule('VoiceChannel', './structures/VoiceChannel');
defineModule('VoiceChannelEffect', './structures/VoiceChannelEffect');
defineModule('VoiceRegion', './structures/VoiceRegion');
defineModule('VoiceState', './structures/VoiceState');
defineModule('Webhook', './structures/Webhook');
defineModule('Widget', './structures/Widget');
defineModule('WidgetMember', './structures/WidgetMember');
defineModule('WelcomeChannel', './structures/WelcomeChannel');
defineModule('WelcomeScreen', './structures/WelcomeScreen');
defineModule('WebSocket', './WebSocket');
defineMember('CustomStatus', './structures/Presence', 'CustomStatus');
defineMember('RichPresence', './structures/Presence', 'RichPresence');
defineMember('SpotifyRPC', './structures/Presence', 'SpotifyRPC');
defineModule('WebEmbed', './structures/WebEmbed');
defineModule('DiscordAuthWebsocket', './util/RemoteAuth');
defineModule('PurchasedFlags', './util/PurchasedFlags');
defineMember('Poll', './structures/Poll', 'Poll');
defineMember('PollAnswer', './structures/PollAnswer', 'PollAnswer');
defineModule('Recorder', './client/voice/receiver/Recorder');
