'use strict';

const EventEmitter = require('node:events');

const TRANSITION_EXPIRY = 10;
const TRANSITION_EXPIRY_PENDING_DOWNGRADE = 24;
const DEFAULT_DECRYPTION_FAILURE_TOLERANCE = 36;

const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

// Optional peer dependency: native DAVE/E2EE implementation. Never required by the package
// itself — when absent, DAVE is simply not advertised to Discord and voice works as before.
let Davey;
let daveyLoaded = false;
function loadDavey() {
  if (!daveyLoaded) {
    daveyLoaded = true;
    try {
      // eslint-disable-next-line global-require
      Davey = require('@snazzah/davey');
    } catch {
      Davey = null;
    }
  }
  return Davey;
}

function getMaxProtocolVersion() {
  const davey = loadDavey();
  return davey?.DAVE_PROTOCOL_VERSION ?? 0;
}

class DAVESession extends EventEmitter {
  constructor(protocolVersion, userId, channelId, options = {}) {
    super();
    this.protocolVersion = protocolVersion;
    this.userId = userId;
    this.channelId = channelId;
    this.failureTolerance = options.decryptionFailureTolerance ?? DEFAULT_DECRYPTION_FAILURE_TOLERANCE;
    this.pendingTransitions = new Map();
    this.downgraded = false;
    this.consecutiveFailures = 0;
    this.reinitializing = false;
    this.lastTransitionId = undefined;
    this.session = undefined;
  }

  get voicePrivacyCode() {
    if (this.protocolVersion === 0 || !this.session?.voicePrivacyCode) return null;
    return this.session.voicePrivacyCode;
  }

  async getVerificationCode(userId) {
    if (!this.session) throw new Error('Session not available');
    return this.session.getVerificationCode(userId);
  }

  reinit() {
    if (this.protocolVersion > 0) {
      const davey = loadDavey();
      if (!davey) {
        this.emit('debug', 'DAVE is unavailable: install the optional `@snazzah/davey` package to enable E2EE voice.');
        return;
      }
      if (this.session) {
        this.session.reinit(this.protocolVersion, this.userId, this.channelId);
        this.emit('debug', `Session reinitialized for protocol version ${this.protocolVersion}`);
      } else {
        this.session = new davey.DAVESession(this.protocolVersion, this.userId, this.channelId);
        this.emit('debug', `Session initialized for protocol version ${this.protocolVersion}`);
      }
      this.emit('keyPackage', this.session.getSerializedKeyPackage());
    } else if (this.session) {
      this.session.reset();
      this.session.setPassthroughMode(true, TRANSITION_EXPIRY);
      this.emit('debug', 'Session reset');
    }
  }

  setExternalSender(externalSender) {
    if (!this.session) throw new Error('No session available');
    try {
      this.session.setExternalSender(externalSender);
      this.emit('debug', 'Set MLS external sender');
    } catch (error) {
      if (String(error).includes('AlreadyInGroup')) {
        this.emit('debug', 'MLS external sender already set, skipping');
        return;
      }
      throw error;
    }
  }

  prepareTransition(data) {
    this.emit('debug', `Preparing for transition (${data.transition_id}, v${data.protocol_version})`);
    this.pendingTransitions.set(data.transition_id, data.protocol_version);

    if (data.transition_id === 0) {
      this.executeTransition(data.transition_id);
    } else {
      if (data.protocol_version === 0) this.session?.setPassthroughMode(true, TRANSITION_EXPIRY_PENDING_DOWNGRADE);
      return true;
    }

    return false;
  }

  executeTransition(transitionId) {
    this.emit('debug', `Executing transition (${transitionId})`);
    if (!this.pendingTransitions.has(transitionId)) {
      this.emit('debug', `Received execute transition, but we don't have a pending transition for ${transitionId}`);
      return false;
    }

    const oldVersion = this.protocolVersion;
    this.protocolVersion = this.pendingTransitions.get(transitionId);

    if (oldVersion !== this.protocolVersion && this.protocolVersion === 0) {
      this.downgraded = true;
      this.emit('debug', 'Session downgraded');
    } else if (transitionId > 0 && this.downgraded) {
      this.downgraded = false;
      this.session?.setPassthroughMode(true, TRANSITION_EXPIRY);
      this.emit('debug', 'Session upgraded');
    }

    this.reinitializing = false;
    this.lastTransitionId = transitionId;
    this.emit('debug', `Transition executed (v${oldVersion} -> v${this.protocolVersion}, id: ${transitionId})`);
    this.pendingTransitions.delete(transitionId);
    return true;
  }

  prepareEpoch(data) {
    this.emit('debug', `Preparing for epoch (${data.epoch})`);
    if (data.epoch === 1) {
      this.protocolVersion = data.protocol_version;
      this.reinit();
    }
  }

  recoverFromInvalidTransition(transitionId) {
    if (this.reinitializing) return;
    this.emit('debug', `Invalidating transition ${transitionId}`);
    this.reinitializing = true;
    this.consecutiveFailures = 0;
    this.emit('invalidateTransition', transitionId);
    this.reinit();
  }

  processProposals(payload, connectedClients) {
    if (!this.session) throw new Error('No session available');
    try {
      const optype = payload.readUInt8(0);
      const { commit, welcome } = this.session.processProposals(
        optype,
        payload.subarray(1),
        Array.from(connectedClients),
      );
      this.emit('debug', 'MLS proposals processed');
      if (!commit) return;
      return welcome ? Buffer.concat([commit, welcome]) : commit;
    } catch (error) {
      this.emit('debug', `MLS proposals errored: ${error}`);
      return null;
    }
  }

  processCommit(payload) {
    if (!this.session) throw new Error('No session available');
    const transitionId = payload.readUInt16BE(0);
    try {
      this.session.processCommit(payload.subarray(2));
      if (transitionId === 0) {
        this.reinitializing = false;
        this.lastTransitionId = transitionId;
      } else {
        this.pendingTransitions.set(transitionId, this.protocolVersion);
      }
      this.emit('debug', `MLS commit processed (transition id: ${transitionId})`);
      return { transitionId, success: true };
    } catch (error) {
      this.emit('debug', `MLS commit errored from transition ${transitionId}: ${error}`);
      this.recoverFromInvalidTransition(transitionId);
      return { transitionId, success: false };
    }
  }

  processWelcome(payload) {
    if (!this.session) throw new Error('No session available');
    const transitionId = payload.readUInt16BE(0);
    try {
      this.session.processWelcome(payload.subarray(2));
      if (transitionId === 0) {
        this.reinitializing = false;
        this.lastTransitionId = transitionId;
      } else {
        this.pendingTransitions.set(transitionId, this.protocolVersion);
      }
      this.emit('debug', `MLS welcome processed (transition id: ${transitionId})`);
      return { transitionId, success: true };
    } catch (error) {
      this.emit('debug', `MLS welcome errored from transition ${transitionId}: ${error}`);
      this.recoverFromInvalidTransition(transitionId);
      return { transitionId, success: false };
    }
  }

  encrypt(packet) {
    if (this.protocolVersion === 0 || !this.session?.ready || packet.equals(SILENCE_FRAME)) return packet;
    return this.session.encryptOpus(packet);
  }

  encryptVideo(packet, codec = 'H264') {
    if (this.protocolVersion === 0 || !this.session?.ready) return packet;
    const davey = loadDavey();
    if (!davey) return packet;
    const codecMap = {
      H264: davey.Codec.H264,
      VP8: davey.Codec.VP8,
      H265: davey.Codec.H265,
      AV1: davey.Codec.AV1,
    };
    return this.session.encrypt(davey.MediaType.VIDEO, codecMap[codec] ?? davey.Codec.UNKNOWN, packet);
  }

  decrypt(packet, userId) {
    const canDecrypt = this.session?.ready && (this.protocolVersion !== 0 || this.session?.canPassthrough(userId));
    if (packet.equals(SILENCE_FRAME) || !canDecrypt || !this.session) return packet;
    try {
      const buffer = this.session.decrypt(userId, loadDavey().MediaType.AUDIO, packet);
      this.consecutiveFailures = 0;
      return buffer;
    } catch (error) {
      if (!this.reinitializing && this.pendingTransitions.size === 0) {
        this.consecutiveFailures++;
        this.emit('debug', `Failed to decrypt a packet (${this.consecutiveFailures} consecutive fails)`);
        if (this.consecutiveFailures > this.failureTolerance) {
          if (this.lastTransitionId) this.recoverFromInvalidTransition(this.lastTransitionId);
          else throw error;
        }
      } else if (this.reinitializing) {
        this.emit('debug', 'Failed to decrypt a packet (reinitializing session)');
      } else if (this.pendingTransitions.size > 0) {
        this.emit('debug', `Failed to decrypt a packet (${this.pendingTransitions.size} pending transition[s])`);
      }
    }
    return null;
  }

  destroy() {
    try {
      this.session?.reset();
    } catch {}
  }
}

module.exports = { DAVESession, getMaxProtocolVersion };
