<div align="center">
  <br />
  <p>
    <img src="docs/logo.svg" width="546" alt="palantir.js" />
  </p>
  <h1>palantir.js</h1>
  <p><strong>A lightweight, Bun-native Discord selfbot library.</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/hipalantir"><img src="https://img.shields.io/npm/v/hipalantir.svg" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/hipalantir"><img src="https://img.shields.io/npm/dt/hipalantir.svg" alt="npm downloads" /></a>
    <a href="https://github.com/ScarysMonsters/palantir.js/actions/workflows/test.yml"><img src="https://github.com/ScarysMonsters/palantir.js/actions/workflows/test.yml/badge.svg" alt="Tests" /></a>
  </p>
</div>

## About

**palantir.js** is maintained by [ScarysMonsters](https://github.com/ScarysMonsters) and is a fork of
[`djs-selfbot-v13`](https://github.com/002-sans/djs-selfbot-v13), which is itself a fork of
[`discord.js-selfbot-v13`](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) by aiko-chan-ai.

Fork chain: `discord.js-selfbot-v13` → `djs-selfbot-v13` → **`palantir.js`**

- `discord.js-selfbot-v13` is based on `discord.js@13.17` with a `discord.js@14.21` backport.
- `palantir.js` keeps that entire API surface and rewrites its runtime on top of Bun/Node builtins.

---

# What's new in palantir.js (compared to `djs-selfbot-v13`)

This is what **this fork** actually changed. The features added by the parent fork are listed in the
[next chapter](#what-djs-selfbot-v13-added-compared-to-discordjs-selfbot-v13).

### Runtime rewrite: 18 dependencies replaced by Bun/Node builtins

| Upstream dependency | palantir.js replacement |
| --- | --- |
| `@discordjs/collection` | `src/util/Collection.js` (full API, `Symbol.species` support) |
| `@discordjs/builders` | `src/util/Formatters.js` (pure JS) |
| `@sapphire/async-queue` | `src/util/AsyncQueue.js` |
| `@sapphire/shapeshift` | native validation in `TextBasedChannel` |
| `undici` | native `fetch` / `FormData` / `Blob` |
| `ws` | `src/WebSocket.js` (adapter over the Bun-native `WebSocket`) |
| `tough-cookie` + `fetch-cookie` | `src/rest/CookieJar.js` |
| `zlib-sync` | `node:zlib` streaming inflate (`InflateStream`) |
| `prism-media` | `src/client/voice/util/Prism.js` (FFmpeg spawn, PCM volume, Ogg/WebM demuxers, Opus) |
| `werift-rtp` | `src/client/voice/util/RtpPacket.js` |
| `find-process` + `tree-kill` | `src/util/ProcessUtil.js` |
| `otplib` | `src/util/TOTP.js` (RFC 6238) |
| `qrcode` | `src/util/QRCode.js` (versions 1-40, EC levels L/M/Q/H) |
| `fluent-ffmpeg` | direct `ffmpeg` probing via `spawn` |
| `discord-api-types` | local constants |
| `erlpack` | not needed (JSON gateway encoding) |

### Bun-first

- Runs on Bun 1.1+ and uses the platform directly: native `fetch`, `WebSocket`, `FormData`, `Blob`,
  `node:zlib`, `node:crypto` and `node:stream` — no shim layer.
- The gateway always uses `zlib-stream` compression through `node:zlib` (no native addon required).

### Fast startup: lazy-loaded API

- Every one of the 165 exports in `src/index.js` is resolved lazily on first access.
- `require('hipalantir')` costs **~6 ms instead of ~330 ms**; the full graph only loads when you
  actually use `Client` or another export. The export surface is byte-for-byte identical (names,
  order, types).

### Native TOTP and QR code

- `src/util/TOTP.js` implements RFC 6238 (validated against the official test vectors) and powers
  `Client` TOTP login (`TOTPKey`) — `otplib` is gone.
- `src/util/QRCode.js` is a complete encoder (versions 1-40, all EC levels) — `qrcode` is gone.
  `DiscordAuthWebsocket#generateQR()` still prints the login QR code in the terminal.

### Voice without native addons

- `opusscript` (pure JS) is installed by default and the Opus encoder/decoder is wired to it, so
  PCM transcoding and `receiver.createStream(..., { mode: 'pcm' })` work out of the box under Bun.
- Ogg (`opus.OggDemuxer`) and WebM (`opus.WebmDemuxer`) demuxers, the FFmpeg wrapper and the PCM
  volume transformer are reimplemented in-repo.
- Raw Opus passthrough (`playOpusStream`) needs no codec engine at all.
- DAVE/E2EE (`@snazzah/davey`) remains a regular dependency: voice works with Discord's E2EE.

### New gateway option

| Option | Default | Description |
| --- | --- | --- |
| `ws.compress` | `false` | Enables the gateway `zlib-stream` compression. Disabled by default to match `djs-selfbot-v13` (plain JSON frames, no `zlib-sync` needed) |

### Built-in captcha solving (NoneCap)

- `NoneCap` implements the `captchaSolver` hook out of the box: it submits the hCaptcha challenge
  (`hcaptcha_enterprise` when `rqdata` is present) to [nonecap.com](https://nonecap.com), polls until
  the solve is terminal and returns the `P1_` token — plus `balance()`, `report()` for feedback and
  `lastSolve` (`resp_key`, solver `user_agent`).
- The client user agent is forwarded to the solver so the token is submitted with the same one.

```js
const { Client, NoneCap } = require('hipalantir');

const client = new Client({
  captchaSolver: NoneCap.solver('nc_live_...'), // or new NoneCap(key, { proxy, waitSeconds, ... })
});
```

### Vanity sniper

`client.user.setSniper(snipeGuild, claimGuild, vanity, options)` watches a vanity through the gateway
(`GUILD_UPDATE` of the origin guild, `GUILD_DELETE`) with a public invite polling fallback, and claims
it on another guild as soon as it is released: a single bounded `PATCH /guilds/:id/vanity-url` with
the 2FA challenge (`60003`) solved lazily through `TOTPKey` (or a password) and replayed once with
`X-Discord-Mfa-Authorization`.

```js
const sniper = client.user.setSniper('origin-guild-id', 'claim-guild-id', 'discord.gg/my-vanity');

sniper.on('drop', info => console.log(`/${info.oldVanity} dropped via ${info.source}`));
sniper.on('claimed', result => console.log(`claimed in ${result.durationMs}ms`));
sniper.on('claimFailed', result => console.error(result.status, result.code));
```

### Fixes

- `DiscordAuthWebsocket#destroy()` now actually closes the WebSocket (`this.ws` → `this.#ws`).
- Added the missing `src/structures/InteractionResponse.js`: the whole source tree is loadable.
- Opus encoder: fixed the `frameSize` argument (opusscript) and the stereo→mono channel mix-up.
- `Util.uploadFile` converts Node streams for the native `fetch`.
- REST: the cookie jar persists `Set-Cookie` headers and replays them per domain, path and security.
- Gateway: binary frames are decoded as `ArrayBuffer` instead of `Blob`, so `zlib-stream` login works on Node without a DOM.
- `Guild#_patch` tracks `vanity_url_code`; `DiscordAPIError.rawError` exposes the raw response body (MFA tickets).

### Tests and CI

- `bun test` — 44 offline tests: TOTP RFC vectors, QR matrix hashes (validated against a real
  decoder), gateway compression, REST pipeline, voice primitives, vanity sniper, NoneCap solver
  and package integrity (lazy exports, no external `require` outside the optional loaders).
- `bun run test:network` — live gateway (HELLO over `zlib-stream`) + REST tests.
- GitHub Actions workflow (`ubuntu` + `windows`).

### Dependency policy

| Package | Type | Purpose |
| --- | --- | --- |
| `@snazzah/davey` | `dependencies` | Voice E2EE (DAVE/MLS) — native binary, cannot be implemented in JS |
| `@snazzah/davey-*` | `optionalDependencies` | Platform binaries for DAVE (darwin/linux/win32) |
| `opusscript` | `optionalDependencies` | Pure-JS Opus codec (no native build) |
| `@dank074/discord-video-stream` | *not installed* | Optional peer for WebRTC Go Live; loaded lazily only if present |

---

# What `djs-selfbot-v13` added (compared to `discord.js-selfbot-v13`)

> [!NOTE]
> Everything in this section comes from the **parent fork** and was already present before
> `palantir.js`. It is translated from the upstream README and kept here for completeness.
> A few API names are corrected to match this codebase (they differ from the upstream README).

### New exports (`src/index.js`)

| Export | Description |
| --- | --- |
| `QuestManager` | Discord quests manager |
| `Quest` | Class representing a quest |
| `BackupManager` | Guild backup/restore manager |
| `GuildJoinRequestManager` | Guild join-request manager |
| `GuildJoinRequest` | Guild join-request structure |

---

### Client (`client.quests`, `client.backups`, `client.developers`)

| Property / Method | Description |
| --- | --- |
| `client.quests` | `QuestManager` instance |
| `client.backups` | `BackupManager` instance |
| `client.developers` | `DeveloperManager` instance |
| `client.login()` | Automatically refreshes client properties (build number, User-Agent) before connecting |

---

### Client options & properties (`Options`, `ClientProperties`)

| Property / Method | Description |
| --- | --- |
| `Options.fetchClientProperties()` | Fetches the latest Discord properties (build number, version, …) |
| `Options.createDefault().questVoiceChannelId` | Default voice channel used for stream/activity quests |
| `ClientProperties.fetchLatest(channel?)` | Scrapes Discord web + desktop manifest for the current build |
| `ClientProperties.awaitLatest(channel?)` | Returns cached properties or fetches them |
| `ClientProperties.ensureFetched(channel?)` | Starts background fetching at startup |
| `ClientProperties.createRuntimeProperties(base)` | Generates WS properties with UUIDs + build info |
| `ClientProperties.applyCached(properties)` | Applies build number, version, native build, User-Agent |
| `ClientProperties.applyToClientOptions(options)` | Updates `ws.properties` and `http.headers` on login |
| `ClientProperties.FALLBACK_WS_PROPERTIES` | Fallback values if fetching fails |

---

### Quests (`client.quests`)

#### `Quest` class

| Method / Property | Description |
| --- | --- |
| `id` | Quest ID |
| `config` | Quest configuration |
| `userStatus` | User status (progress, enrollment, …) |
| `raw` | Raw API data |
| `isExpired(date?)` | Whether the quest is expired |
| `isCompleted()` | Whether the quest is completed |
| `hasClaimedRewards()` | Whether the rewards were claimed |
| `isEnrolledQuest()` | Whether the user is enrolled |
| `updateUserStatus(status)` | Updates the cached status |

#### `QuestManager`

| Method / Property | Description |
| --- | --- |
| `cache` | `Collection<string, Quest>` |
| `get()` / `fetchQuests()` | Fetches all quests (`/quests/@me`) |
| `orbs()` | Virtual currency (Orbs) balance |
| `getQuest(id)` | Cached quest by ID |
| `list()` | All cached quests |
| `getExpired(date?)` | Expired quests |
| `getCompleted()` | Completed quests |
| `getClaimable()` | Completed but unclaimed quests |
| `filterQuestsValid()` | Not completed and not expired quests |
| `filterQuestsValidToRedeem()` | Alias for `getClaimable()` |
| `hasQuest(id)` | Whether the quest is cached |
| `getApplicationData(ids)` | Public application metadata |
| `acceptQuest(questId, options?)` | Enrolls in a quest (Android support) |
| `videoProgress(questId, timestamp, options?)` | Video progress |
| `heartbeat(questId, appIdOrOptions, terminal?)` | Desktop/activity/stream heartbeat |
| `redeemQuest(quest)` | Claims the rewards |
| `doingQuest(quest)` | Auto-completes one quest |
| `autoCompleteAll({ redeem? })` | Auto-completes every valid quest |
| `size` / `clear()` | Cache size / clear |
| `[Symbol.iterator]()` | Iterates over cached quests |

**Auto-completable quest types:**
- `WATCH_VIDEO` / `WATCH_VIDEO_ON_MOBILE`
- `PLAY_ON_DESKTOP` / `PLAY_ON_XBOX` / `PLAY_ON_PLAYSTATION`
- `PLAY_ACTIVITY`
- `STREAM_ON_DESKTOP` *(via WS voice)*
- `ACHIEVEMENT_IN_ACTIVITY`

```js
await client.quests.get();
const valid = client.quests.filterQuestsValid();
for (const quest of valid) {
  await client.quests.doingQuest(quest);
}
```

---

### Backups (`client.backups`)

| Method | Description |
| --- | --- |
| `create(guildId, options?)` | Creates a guild backup |
| `load(guildId, backupId, options?)` | Restores a backup |
| `get(backupId)` | Retrieves a backup (`id`, `data`, `size`) |
| `list()` | Lists every backup ID |
| `delete(backupId)` | Deletes a backup |
| `clearAll()` | Deletes every backup |

**`create` options:** `backupID`, `maxMessagesPerChannel`, `doNotBackup`, `backupMembers`, `saveImages`
**`load` options:** `clearGuildBeforeRestore`, `maxMessagesPerChannel`, `doNotBackup`

```js
const backup = await client.backups.create(guild.id, {
  maxMessagesPerChannel: 50,
  backupMembers: true,
});
await client.backups.load(guild.id, backup.id);
```

---

### Join requests (`guild.demandes`)

> The manager is named `demandes` (French) in the parent fork — kept as-is for compatibility.

| Method / Property | Description |
| --- | --- |
| `cache` | `Collection<Snowflake, GuildJoinRequest>` |
| `resolve(request)` | Resolves a resolvable into a `GuildJoinRequest` |
| `resolveId(request)` | Resolves into a string ID |

#### `GuildJoinRequest`

| Property / Method | Description |
| --- | --- |
| `id`, `userId`, `user`, `status`, `responses` | Request data |
| `createdTimestamp`, `createdAt` | Creation date |
| `approuve()` | Approves the request |
| `reject(reason?)` | Rejects the request |
| `interview()` | Starts an interview |

#### `Guild`

| Property | Description |
| --- | --- |
| `demandes` | `GuildJoinRequestManager` |
| `profile` | `{ badge, tag }` — guild profile/tag |

**Events:**
- `guildJoinRequestCreate` — new or updated request
- `guildJoinRequestDelete` — request deleted

---

### Developer applications (`client.developers`)

| Method | Description |
| --- | --- |
| `get(withTeamApplications?)` | Lists owned applications |
| `list(withTeamApplications?)` | Alias for `get` |
| `fetch(applicationId)` | Fetches one application |
| `edit(applicationId, data)` | Edits the metadata |
| `setAvatar(applicationId, avatar)` | Changes the icon |
| `setName(applicationId, name)` | Changes the name |
| `setDescription(applicationId, description)` | Changes the description |
| `setTags(applicationId, tags)` | Sets tags (max 5) |
| `addTag(applicationId, tag)` | Adds a tag |
| `delTag(applicationId, tag)` | Removes a tag |
| `enableIntents(applicationId)` | Enables privileged intents |
| `disableIntents(applicationId)` | Disables privileged intents |

---

### ClientUser (user profile)

| Method | Description |
| --- | --- |
| `addWidget(type, gameId, comment?, tags?)` | Adds a profile widget (playing/recently played) |
| `delWidget(type, gameId?)` | Removes a widget |
| `widgetsList()` | Lists profile widgets |
| `setNameStyle(fontName, effectName, color1, color2?)` | Name style (font, effect, gradient) |
| `setHypeSquad(type)` | Sets the HypeSquad house (`1`, `'HOUSE_BRAVERY'`, `0` to clear) |
| `setAboutMe(bio?)` | Sets the profile bio |
| `searchTab(options?)` | Searches your own messages |
| `setClan(guild)` | Displays a guild identity tag |
| `deleteClan()` | Removes the identity tag |
| `fetchProfile(userId, options?)` | Full profile (bio, banner, badges, mutual friends/guilds, widgets) |

Custom status is managed through the settings manager:

```js
await client.settings.setCustomStatus({ text: 'hello', emoji: '👋', expires: null });
```

| Method (`client.settings`) | Description |
| --- | --- |
| `fetch()` / `edit(data)` | Fetch/update user settings |
| `setCustomStatus(options)` | Sets the custom status (text, emoji, expiry) |
| `toggleCompactMode()` | Toggles compact mode |
| `setTheme(value)` | Sets the theme (`dark`, `light`, `darker`) |
| `restrictedGuilds` / `addRestrictedGuild` / `removeRestrictedGuild` | Age-restricted guild list management |

---

### Voice — WS-first session (`client.voice.joinVoice`)

Joins a voice channel through the gateway first; the UDP link is only created when media playback
requires it. Ideal for stream/activity quests.

```js
const voice = await client.voice.joinVoice(channelId, {
  mute: true,
  deaf: true,
  stream: true,
});

await voice.setStream(true);
await voice.setMute(true);
await voice.disconnect();
```

| Method / Property | Description |
| --- | --- |
| `ClientVoiceManager.joinVoice(channel, options?)` | Joins a channel (WS-first, UDP on demand) |
| `ClientVoiceManager.preJoinCleanup(channel)` | Cleans voice/stream state before joining |
| `ClientVoiceManager.onVoiceServer(payload)` / `onVoiceStateUpdate(payload)` | Gateway voice event handlers |
| `VoiceSession.streamKey` | Discord stream key (`guild:…` or `call:…`) |
| `VoiceSession.disconnected` | Whether the session ended |
| `VoiceSession.setMute(mute?)` | Self mute (op 4) |
| `VoiceSession.setDeaf(deaf?)` | Self deaf (op 4) |
| `VoiceSession.setVideo(video?)` | Camera on/off (op 4) |
| `VoiceSession.setStream(stream?)` | Go Live on/off (op 18 / 19) |
| `VoiceSession.setStreamLink(link)` / `setVideoLink(link)` | Attaches a stream/video source |
| `VoiceSession.pauseStream()` / `unpauseStream()` | Pauses/resumes the screenshare (op 22) |
| `VoiceSession.streamTime(ms)` | Seeks the stream |
| `VoiceSession.disconnect()` | Leaves the channel + stops the stream |

**Helpers exported from `src/client/voice/VoiceSession.js`** (`WsVoiceSession.js` re-exports the same module for compatibility):
- `getStreamKey(channel, userId)` — `guild:guildId:channelId:userId` or `call:channelId:userId`
- `normalizeData(options)` — normalises option aliases
- `waitForSelfVoiceState(client, predicate, timeout?)` — waits for a `VOICE_STATE_UPDATE`

**`joinVoice` options** (normalised by `normalizeData`): `mute`, `deaf`, `stream`, `video`,
`streamLink`, `videoLink`, `preferredRegion`, …

---

### Voice — WebRTC Go Live (`WebRtcStreamSession`)

`src/client/voice/WebRtcStreamSession.js` streams video over WebRTC and is based on the optional
`@dank074/discord-video-stream` peer (lazy-loaded, not installed by default).

| Method / Event | Description |
| --- | --- |
| `start()` | Joins voice + starts the WebRTC stream |
| `pause()` | Pauses |
| `resume()` | Resumes |
| `stop()` | Stops playback |
| `replay()` | Replays from the start |
| `disconnect()` | Stops + leaves voice |
| `'playing'`, `'finish'`, `'error'`, `'debug'` | Session events |

Encoder is auto-detected: `amf` → `nvenc` → `libx264`.

---

### Voice — UDP stream (`StreamSession`)

| Method | Description |
| --- | --- |
| `StreamSession.resolveUrl(url)` | Downloads an HTTP video to a temporary file |
| `start()` | Starts the UDP FFmpeg pipeline |
| `pause()` / `resume()` / `stop()` / `replay()` | Playback control |
| `disconnect()` | Stops + disconnects voice and stream |

---

### Voice — DAVE encryption (`DAVESession`)

Discord end-to-end audio/video encryption via `@snazzah/davey`.

| Method / Property | Description |
| --- | --- |
| `VoiceConnection.dave` | `DAVESession` instance |
| `VoiceConnection.isDaveReady()` | Whether the DAVE session is ready |
| `VoiceConnection.waitForDaveReady()` | Waits until DAVE is ready |
| `VoiceConnection.getStreamSsrcs()` | `{ audioSsrc, videoSsrc, rtxSsrc }` |
| `VoiceConnection.stopExistingStream()` | Gracefully stops an active screenshare |
| `DAVESession.voicePrivacyCode` | E2EE privacy code |
| `DAVESession.getVerificationCode(userId)` | Per-user verification code |
| `DAVESession.reinit()` | Reinitialises the MLS session |
| `DAVESession.setExternalSender(data)` | Sets the MLS external sender |
| `DAVESession.prepareTransition(data)` | Prepares a protocol transition |
| `DAVESession.executeTransition(id)` | Executes a transition |
| `DAVESession.prepareEpoch(data)` | Prepares an epoch |
| `DAVESession.processProposals(payload, clients)` | MLS handshake — proposals |
| `DAVESession.processCommit(payload)` | MLS handshake — commit |
| `DAVESession.processWelcome(payload)` | MLS handshake — welcome |
| `DAVESession.encrypt(packet)` | Encrypts an audio packet |
| `DAVESession.encryptVideo(packet, codec?)` | Encrypts a video packet |
| `DAVESession.decrypt(packet, userId)` | Decrypts a packet |
| `DAVESession.destroy()` | Destroys the session |

**Voice opcodes (`Constants.VoiceOpcodes`):** `CLIENTS_CONNECT`, `DAVE_PREPARE_TRANSITION`,
`DAVE_EXECUTE_TRANSITION`, `DAVE_TRANSITION_READY`, `DAVE_PREPARE_EPOCH`, `DAVE_MLS_*` (25–31)

---

### Voice — Voice channels

| Class | Method / Property | Description |
| --- | --- | --- |
| `BaseGuildVoiceChannel` | `status` | Voice channel status (max 500 characters) |
| `BaseGuildVoiceChannel` | `setStatus(status?)` | Sets or clears the status (`PUT /channels/:id/voice-status`) |
| `VoiceChannel` / `StageChannel` | `setStatus(status?)` | Inherit from `BaseGuildVoiceChannel` |

```js
await voiceChannel.setStatus('Hello!');
await voiceChannel.setStatus(null); // remove
```

---

### Voice — `VoiceConnection` improvements

| Method | Description |
| --- | --- |
| `setVideoStatus(value)` | Sends the `SOURCES` packet with video/RTX SSRCs |
| `sendVoiceStateUpdate(options)` | Sets `flags: 2` when `self_video` is active |
| `checkAuthenticated()` | Checks `serverId` when the DAVE protocol is active |
| `cleanup()` | DAVE session cleanup / shared session detection |
| `createStreamConnection()` | Creates a UDP stream connection |
| `joinStreamConnection(user)` | Joins a user's stream |
| `StreamConnection.sendSignalScreenshare()` | Go Live signal (op 18) |
| `StreamConnection.sendStopScreenshare()` | Stream stop (op 19) |
| `StreamConnection.sendScreenshareState(paused?)` | Pause/unpause the stream (op 22) |

---

## Requirements

- **Bun ≥ 1.1.0** (developed and tested on Bun; Node.js compatibility is not guaranteed)

## Installation

```sh-session
bun add hipalantir
```

## Quick start

```js
const { Client } = require('hipalantir');

const client = new Client();

client.on('ready', () => {
  console.log(`${client.user.username} is ready!`);
});

client.login('token');
```

QR login is also available (no token needed, scan from the mobile app):

```js
client.QRLogin();
```

## Tests

```sh-session
bun test            # offline suite (native utils, package integrity)
bun run test:network  # live Discord tests (gateway + REST)
```

## Documentation

The API reference is generated from the JSDoc comments into `docs/main.json` and rendered by the
static viewer in `docs/index.html`.

```sh-session
bun run docs          # regenerate docs/main.json from src/
bunx serve docs       # preview the site locally (any static server works)
```

Deploying on Netlify (config already provided in `netlify.toml`, publish directory: `docs`):

1. Push this repository to GitHub.
2. On [app.netlify.com](https://app.netlify.com): **Add new site → Import an existing project**, pick the repo.
   The prebuilt docs are static, so no build command is needed.
3. Or drag-and-drop the `docs/` folder onto [app.netlify.com/drop](https://app.netlify.com/drop) for a one-off deploy.
4. Netlify can regenerate the docs on every deploy: set the build command to
   `curl -fsSL https://bun.sh/install | bash && ~/.bun/bin/bun install && ~/.bun/bin/bun run docs`
   (uncomment it in `netlify.toml`).

---

<div align="center">
  <p>
    <a href="https://github.com/ScarysMonsters/palantir.js"><img src="https://img.shields.io/badge/GitHub-ScarysMonsters%2Fpalantir.js-blue" alt="GitHub" /></a>
  </p>
</div>

> [!WARNING]
> **I do not take any responsibility for blocked Discord accounts that used this module.**

> [!CAUTION]
> **Using this on a user account is prohibited by the [Discord TOS](https://discord.com/terms) and can lead to the account block.**

## Features (User)

- [x] Message
- [x] ClientUser: Status, Activity, RemoteAuth/QR login, CustomStatus, Widgets, Clan, Profile, etc.
- [x] Guild: Fetch Members, Join / Leave, Top emojis, Join Requests, Profile tag, etc.
- [x] Interactions: Slash Commands, Buttons, Menu, Modal
- [x] Quests: Auto-complete (video, desktop, activity, stream, achievement)
- [x] Voice: WS-first sessions, WebRTC Go Live, UDP stream, DAVE E2EE
- [x] Backups: guild backup/restore
- [x] Developer: bot application management
- [x] VoiceChannel.setStatus
- [x] ClientProperties: automatic build number
- [x] Captcha solver hook: native TOTP handler, built-in NoneCap (hCaptcha) solver
- [x] Vanity Sniper: gateway + polling watch, single-shot claim, lazy MFA
- [x] Dependency-light runtime & lazy-loaded API
- [ ] Complete API documentation

### [Example Code](https://github.com/ScarysMonsters/palantir.js/tree/main/examples)

## Get Token?

Based on: [findByProps](https://discord.com/channels/603970300668805120/1085682686607249478/1085682686607249478)

<strong>Run this code (Discord Console — [Ctrl + Shift + I])</strong>

```js
window.webpackChunkdiscord_app.push([
	[Symbol()],
	{},
	req => {
		if (!req.c) return;
		for (let m of Object.values(req.c)) {
			try {
				if (!m.exports || m.exports === window) continue;
				if (m.exports?.getToken) return copy(m.exports.getToken());
				for (let ex in m.exports) {
					if (m.exports?.[ex]?.getToken && m.exports[ex][Symbol.toStringTag] !== 'IntlMessagesProxy') return copy(m.exports[ex].getToken());
				}
			} catch {}
		}
	},
]);

window.webpackChunkdiscord_app.pop();
console.log('%cWorked!', 'font-size: 50px');
console.log(`%cYou now have your token in the clipboard!`, 'font-size: 16px');
```

## Contributing

- Before creating an issue, please make sure it has not already been reported/suggested.
- Run `bun test` before opening a PR and keep the zero-require-architecture rule
  (external `require`s are only allowed in the optional loaders: DAVE, Opus engines and the
  video-stream peer).

## Need help?

GitHub Discussions: [ScarysMonsters/palantir.js](https://github.com/ScarysMonsters/palantir.js/discussions)

## Credits

- [discord.js](https://github.com/discordjs/discord.js)
- [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) by aiko-chan-ai
- [djs-selfbot-v13](https://github.com/002-sans/djs-selfbot-v13) by 002-sans
- [@dank074/Discord-video-stream](https://github.com/dank074/Discord-video-stream) for the video streaming implementation
- Maintained by [ScarysMonsters](https://github.com/ScarysMonsters)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ScarysMonsters/palantir.js&type=Date)](https://star-history.com/#ScarysMonsters/palantir.js&Date)
