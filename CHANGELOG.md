# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `rateLimitRetryLimit` client option (default `5`): caps how many consecutive `429` retries a request may consume; a durable rate limit now throws `RateLimitError` instead of looping.
- `CloudflareBanError` (code `40333`) and the `cloudflareBan` event: Cloudflare blocks are surfaced as their own error and broadcast so applications can pause requests.
- `Invite#showVerificationForm`: whether the guild's member verification (rule screening) form will be shown to the joining user.

### Changed

- `restGlobalRateLimit` now defaults to `50` req/s (the documented per-user budget) instead of being disabled; set it to `0` to opt out.
- POSTs to `/channels/:id/messages` now carry an auto-generated nonce, making abort-and-retry safe to de-duplicate server-side.

### Fixed

- `429` responses without timing headers: bounded exponential backoff with jitter instead of an immediate tight-loop retry.
- `5xx` responses: exponential backoff and an early bail-out when `X-Failed-Requests` exceeds `retryLimit`.
- Queued responses (`202` with a code starting with `11`) are retried respecting `retry_after` instead of being treated as a payload.
- Captcha handling no longer crashes when `captcha_key` is missing, forwards `captcha_rqdata` to the solver, sends the captcha session id (`X-Captcha-Session-Id`) and keeps solved keys and TOTP codes out of debug logs.
- Rate limit buckets shared by sibling routes (same `X-RateLimit-Bucket` hash) now share a single request handler, avoiding self-inflicted `429`s on buckets like members/presences.
- `429`s scoped `shared` are no longer counted as invalid requests toward the 10k/10min ban threshold.
- The request-error retry is bounded even when `retryLimit` is missing from the options object.
- `Client#acceptInvite()` sends the official client's join context (`Join Guild` with `location_guild_id` / `location_channel_id` / `location_channel_type`) instead of a bare `Markdown Link`, which Discord anti-abuse rejected as `403 10008` "Unknown Message"; a debug line now explains that block.
- Member verification is now actually submitted after joining: the `invite_code` passed was `undefined`, and the check only looked at `show_verification_form` on the accept response (present on the resolve payload instead).

### Security

- WebSocket packets, HTTP errors and debug output no longer leak secrets: tokens, captcha keys, MFA payloads and `Authorization` headers are redacted or dropped.
- Configuring a proxy under Bun now fails with an explicit `PROXY_NOT_SUPPORTED` error instead of being silently ignored.

## [10.9.23] - 2026-10-18

### Added

- Optional Chrome-fingerprint REST transport (`http.transport: 'chrome'`) built on `node:https` with Chrome's TLS cipher order and HTTP/1.1 keep-alive (Bun's `fetch` ignores TLS options).
- Built-in `NoneCap` hCaptcha solver usable as the `captchaSolver` hook (`NoneCap.solver`).
- `UserConnectionManager` (`client.connections`) managing `/users/@me/connections` entries (domains, games, social accounts), plus `ClientUser#fetchUserAffinities()`.

[Unreleased]: https://github.com/ScarysMonsters/palantir.js/commits/main
[10.9.23]: https://www.npmjs.com/package/hipalantir/v/10.9.23
