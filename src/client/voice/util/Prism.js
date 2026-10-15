'use strict';

/**
 * Zero dependency replacement for the parts of `prism-media` used by this library.
 * FFmpeg wrapping, PCM volume transforms and Opus codecs/demuxers implemented on top
 * of Node/Bun builtins only. Native Opus engines remain optional (they are never
 * installed automatically) and are loaded dynamically when present.
 */

const { spawn } = require('node:child_process');
const { Transform, Readable } = require('node:stream');
const { Buffer } = require('node:buffer');

/* -------------------------------------------------------------------------- */
/* Opus engine loading                                                        */
/* -------------------------------------------------------------------------- */

let opusEngine;

function findOpusEngine() {
  if (opusEngine !== undefined) return opusEngine;
  opusEngine = null;
  try {
    // eslint-disable-next-line global-require
    const discordjsOpus = require('@discordjs/opus');
    opusEngine = {
      name: '@discordjs/opus',
      Encoder: discordjsOpus.OpusEncoder,
      Decoder: discordjsOpus.OpusDecoder,
    };
    return opusEngine;
  } catch {}
  try {
    // eslint-disable-next-line global-require
    const nodeOpus = require('node-opus');
    opusEngine = {
      name: 'node-opus',
      Encoder: nodeOpus.OpusEncoder,
      Decoder: nodeOpus.OpusDecoder,
    };
    return opusEngine;
  } catch {}
  try {
    // eslint-disable-next-line global-require
    const OpusScript = require('opusscript');
    opusEngine = { name: 'opusscript', Encoder: OpusScript, Decoder: OpusScript };
    return opusEngine;
  } catch {}
  return null;
}

function requireOpusEngine() {
  const engine = findOpusEngine();
  if (!engine) {
    throw new Error(
      'No Opus engine available. Install one of `@discordjs/opus`, `node-opus` or `opusscript` to use PCM/Opus transcoding.',
    );
  }
  return engine;
}

/* -------------------------------------------------------------------------- */
/* FFmpeg                                                                     */
/* -------------------------------------------------------------------------- */

const FFMPEG_PCM_OUTPUT = ['-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];

/**
 * A Readable stream of the ffmpeg process stdout.
 */
class FFmpeg extends Readable {
  constructor({ args = [], ...options } = {}) {
    super(options);
    this.args = [...args, ...FFMPEG_PCM_OUTPUT];
    this.process = spawn('ffmpeg', this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.process.stdout.on('data', chunk => {
      if (!this.push(chunk)) this.process.stdout.pause();
    });
    this.process.stdout.on('end', () => this.push(null));
    this.process.stderr.on('data', () => null);
    this.process.once('error', error => this.destroy(error));
    this.process.once('close', code => {
      if (code !== 0 && !this.destroyed) {
        this.destroy(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  }

  _read() {
    this.process.stdout.resume();
  }

  _destroy(error, callback) {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      try {
        this.process.kill('SIGKILL');
      } catch {}
    }
    callback(error);
  }
}

/* -------------------------------------------------------------------------- */
/* VolumeTransformer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Transforms PCM s16le audio, scaling samples by `volume`.
 */
class VolumeTransformer extends Transform {
  constructor({ type = 's16le', volume = 1 } = {}) {
    super();
    this.type = type;
    this._volume = volume;
    this._remainder = null;
  }

  get volume() {
    return this._volume;
  }

  set volume(value) {
    this.setVolume(value);
  }

  setVolume(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError('Volume must be a number.');
    this._volume = value;
  }

  setVolumeDecibels(db) {
    this.setVolume(Math.pow(10, db / 20));
  }

  setVolumeLogarithmic(value) {
    this.setVolume(Math.pow(value, 1.660964));
  }

  get volumeDecibels() {
    return Math.log10(this._volume) * 20;
  }

  get volumeLogarithmic() {
    return Math.pow(this._volume, 1 / 1.660964);
  }

  _transform(chunk, _encoding, callback) {
    if (this.type !== 's16le') {
      // Non-PCM data is passed through untouched.
      return callback(null, chunk);
    }
    let buffer = chunk;
    if (this._remainder) {
      buffer = Buffer.concat([this._remainder, buffer]);
      this._remainder = null;
    }
    const bytesPerSample = 2;
    const usableLength = buffer.length - (buffer.length % bytesPerSample);
    if (usableLength !== buffer.length) {
      this._remainder = buffer.subarray(usableLength);
      buffer = buffer.subarray(0, usableLength);
    }
    const output = Buffer.allocUnsafe(buffer.length);
    for (let i = 0; i < buffer.length; i += 2) {
      let sample = buffer.readInt16LE(i);
      sample = Math.max(-32768, Math.min(32767, Math.round(sample * this._volume)));
      output.writeInt16LE(sample, i);
    }
    callback(null, output);
  }
}

/* -------------------------------------------------------------------------- */
/* Opus                                                                       */
/* -------------------------------------------------------------------------- */

class OpusDecoder extends Transform {
  constructor({ channels = 2, rate = 48000, frameSize = 960 } = {}) {
    super();
    const engine = requireOpusEngine();
    this.options = { channels, rate, frameSize };
    this.engine = engine;
    if (engine.name === 'opusscript') {
      this.decoder = new engine.Decoder(rate, channels);
      this.decoder.setFrameSize?.(frameSize);
    } else {
      this.decoder = new engine.Decoder(rate, channels);
    }
  }

  _transform(chunk, _encoding, callback) {
    try {
      const decoded = this.decoder.decode(chunk, this.options.frameSize);
      callback(null, Buffer.from(decoded));
    } catch (error) {
      callback(error);
    }
  }

  _destroy(error, callback) {
    try {
      this.decoder?.delete?.();
    } catch {}
    callback(error);
  }
}

class OpusEncoder extends Transform {
  constructor({ channels = 2, rate = 48000, frameSize = 960, bitrate } = {}) {
    super();
    const engine = requireOpusEngine();
    this.options = { channels, rate, frameSize };
    this.engine = engine;
    this._buffers = [];
    this._bufferLength = 0;
    this._frameSizeBytes = frameSize * channels * 2;
    if (engine.name === 'opusscript') {
      this.encoder = new engine.Encoder(rate, channels);
      this.encoder.setFrameSize?.(frameSize);
    } else {
      this.encoder = new engine.Encoder(rate, channels);
    }
    if (bitrate) this.setBitrate(bitrate);
  }

  setBitrate(bitrate) {
    this.encoder.setBitrate?.(bitrate);
    return true;
  }

  setFEC(enabled) {
    this.encoder.setFEC?.(enabled);
    return true;
  }

  setPLP(value) {
    this.encoder.setPacketLossPercent?.(value * 100);
    return true;
  }

  _encodeFrame(frame) {
    // opusscript requires the frame size as second argument, @discordjs/opus ignores it.
    return this.encoder.encode(frame, this.options.frameSize);
  }

  _transform(chunk, _encoding, callback) {
    try {
      this._buffers.push(chunk);
      this._bufferLength += chunk.length;
      while (this._bufferLength >= this._frameSizeBytes) {
        let frame;
        if (this._buffers.length === 1) {
          frame = this._buffers[0];
          if (frame.length > this._frameSizeBytes) {
            this._buffers[0] = frame.subarray(this._frameSizeBytes);
            frame = frame.subarray(0, this._frameSizeBytes);
          } else {
            this._buffers = [];
          }
        } else {
          const merged = Buffer.concat(this._buffers);
          frame = merged.subarray(0, this._frameSizeBytes);
          this._buffers = [merged.subarray(this._frameSizeBytes)];
        }
        this._bufferLength -= this._frameSizeBytes;
        const encoded = this._encodeFrame(frame);
        if (encoded && encoded.length) this.push(Buffer.from(encoded));
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _destroy(error, callback) {
    try {
      this.encoder?.delete?.();
    } catch {}
    callback(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Ogg demuxer                                                                */
/* -------------------------------------------------------------------------- */

const OGG_CAPTURE = Buffer.from('OggS');

class OggDemuxer extends Transform {
  constructor(options = {}) {
    super(options);
    this._buffer = null;
    this._packet = [];
    this._skippedHeaders = 0;
  }

  _transform(chunk, _encoding, callback) {
    this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : Buffer.from(chunk);
    try {
      this._parse();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _parse() {
    let offset = 0;
    while (this._buffer) {
      const start = this._buffer.indexOf(OGG_CAPTURE, offset);
      if (start === -1) {
        this._buffer = this._buffer.subarray(Math.max(0, this._buffer.length - 3));
        return;
      }
      if (start > 0) this._buffer = this._buffer.subarray(start);
      if (this._buffer.length < 27) return;
      const segmentCount = this._buffer[26];
      const headerSize = 27 + segmentCount;
      if (this._buffer.length < headerSize) return;
      const segmentTable = this._buffer.subarray(27, headerSize);
      let dataSize = 0;
      for (const length of segmentTable) dataSize += length;
      if (this._buffer.length < headerSize + dataSize) return;

      const data = this._buffer.subarray(headerSize, headerSize + dataSize);
      this._buffer = this._buffer.subarray(headerSize + dataSize);
      offset = 0;

      // Skip OpusHead / OpusTags header pages.
      if (this._skippedHeaders < 2) {
        this._skippedHeaders++;
        continue;
      }

      let dataOffset = 0;
      for (const length of segmentTable) {
        const segment = data.subarray(dataOffset, dataOffset + length);
        dataOffset += length;
        this._packet.push(segment);
        if (length < 255) {
          if (this._packet.length > 0) this.push(Buffer.concat(this._packet));
          this._packet = [];
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* WebM (matroska) demuxer                                                    */
/* -------------------------------------------------------------------------- */

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  CLUSTER: 0x1f43b675,
  BLOCK_GROUP: 0xa0,
  SIMPLE_BLOCK: 0xa3,
  BLOCK: 0xa1,
  TIMESTAMP: 0xe7,
  TRACKS: 0x1654ae6b,
  INFO: 0x1549a966,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  CLUSTER_TIMESTAMP: 0xe7,
  BLOCK_DURATION: 0x9b,
  REFERENCE_BLOCK: 0xfb,
  CLUSTER_POSITION: 0xa7,
  CODEC_ID: 0x86,
  VOID: 0xec,
  CRC32: 0xbf,
};

class WebmDemuxer extends Transform {
  constructor(options = {}) {
    super(options);
    this._buffer = null;
    this._trackNumber = null;
    this._inCluster = false;
    this._skipElement = null;
  }

  _transform(chunk, _encoding, callback) {
    this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : Buffer.from(chunk);
    try {
      this._parse();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _readVInt(offset, keepMarker = false) {
    if (offset >= this._buffer.length) return null;
    const first = this._buffer[offset];
    if (first === 0) return null;
    let length = 1;
    let mask = 0x80;
    while (!(first & mask)) {
      mask >>= 1;
      length++;
      if (length > 8) return null;
    }
    if (this._buffer.length < offset + length) return null;
    let value = keepMarker ? first : first & (mask - 1);
    for (let i = 1; i < length; i++) value = value * 256 + this._buffer[offset + i];
    return { value, length };
  }

  _parse() {
    while (this._buffer && this._buffer.length > 0) {
      // Currently inside a cluster: parse its children.
      const idInfo = this._readVInt(0, true);
      if (!idInfo) return;
      const id = idInfo.value;
      const sizeInfo = this._readVInt(idInfo.length);
      if (!sizeInfo) return;
      let size = sizeInfo.value;
      const headerSize = idInfo.length + sizeInfo.length;
      const unknownSize = size === Math.pow(2, 7 * sizeInfo.length) - 1;

      if (id === ID.SEGMENT && unknownSize) {
        this._buffer = this._buffer.subarray(headerSize);
        continue;
      }
      if (id === ID.CLUSTER && unknownSize) {
        this._buffer = this._buffer.subarray(headerSize);
        this._inCluster = true;
        continue;
      }
      if (unknownSize) {
        // Unsupported unknown-size element outside Segment/Cluster: skip it entirely.
        this._buffer = this._buffer.subarray(headerSize);
        continue;
      }
      const total = headerSize + size;
      if (this._buffer.length < total) return;
      const payload = this._buffer.subarray(headerSize, total);
      this._buffer = this._buffer.subarray(total);

      if (id === ID.SEGMENT) {
        // Descend into segment: re-queue its payload for parsing.
        this._buffer = Buffer.concat([payload, this._buffer]);
        continue;
      }
      if (id === ID.CLUSTER) {
        this._inCluster = true;
        this._buffer = Buffer.concat([payload, this._buffer]);
        continue;
      }
      if (id === ID.SIMPLE_BLOCK || (id === ID.BLOCK && this._inCluster)) {
        this._handleBlock(payload, id === ID.SIMPLE_BLOCK);
        continue;
      }
      if (id === ID.TRACKS || id === ID.INFO || id === ID.BLOCK_GROUP) {
        this._buffer = Buffer.concat([payload, this._buffer]);
        continue;
      }
      // Other elements (timestamps, codec ids, …) are ignored.
    }
  }

  _handleBlock(payload, simpleBlock) {
    const trackInfo = this._readVIntFrom(payload, 0);
    if (!trackInfo) return;
    const trackNumber = trackInfo.value;
    let offset = trackInfo.length;
    if (this._trackNumber === null) this._trackNumber = trackNumber;
    if (trackNumber !== this._trackNumber) return;
    offset += 2; // relative timestamp
    if (offset > payload.length) return;
    const flags = payload[offset];
    offset += 1;
    if (simpleBlock && flags & 0x02) return; // invisible keyframe flag not used for skipping
    const lacing = (flags >> 1) & 0x03;
    if (!lacing) {
      if (offset < payload.length) this.push(payload.subarray(offset));
      return;
    }
    // Lacing: first byte is the frame count minus one.
    if (offset >= payload.length) return;
    const frameCount = payload[offset] + 1;
    offset += 1;
    const sizes = [];
    if (lacing === 0x01) {
      // Xiph lacing
      for (let i = 0; i < frameCount - 1; i++) {
        let size = 0;
        while (offset < payload.length && payload[offset] === 255) {
          size += 255;
          offset++;
        }
        if (offset >= payload.length) return;
        size += payload[offset];
        offset++;
        sizes.push(size);
      }
    } else if (lacing === 0x03) {
      // EBML lacing
      let previous = 0;
      for (let i = 0; i < frameCount - 1; i++) {
        const valueInfo = this._readVIntFrom(payload, offset);
        if (!valueInfo) return;
        offset += valueInfo.length;
        const signed = valueInfo.value - (Math.pow(2, 7 * valueInfo.length - 1) - 1);
        const size = i === 0 ? valueInfo.value : previous + signed;
        previous = size;
        sizes.push(size);
      }
    } else {
      // Fixed-size lacing
      const remaining = payload.length - offset;
      const size = Math.floor(remaining / frameCount);
      for (let i = 0; i < frameCount - 1; i++) sizes.push(size);
    }
    for (const size of sizes) {
      if (offset + size > payload.length) return;
      this.push(payload.subarray(offset, offset + size));
      offset += size;
    }
    if (offset < payload.length) this.push(payload.subarray(offset));
  }

  _readVIntFrom(buffer, offset) {
    if (offset >= buffer.length) return null;
    const first = buffer[offset];
    if (first === 0) return null;
    let length = 1;
    let mask = 0x80;
    while (!(first & mask)) {
      mask >>= 1;
      length++;
      if (length > 8) return null;
    }
    if (buffer.length < offset + length) return null;
    let value = first & (mask - 1);
    for (let i = 1; i < length; i++) value = value * 256 + buffer[offset + i];
    return { value, length };
  }
}

module.exports = {
  FFmpeg,
  VolumeTransformer,
  opus: {
    Decoder: OpusDecoder,
    Encoder: OpusEncoder,
    OggDemuxer,
    WebmDemuxer,
  },
  findOpusEngine,
};
