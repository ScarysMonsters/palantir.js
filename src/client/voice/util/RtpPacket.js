'use strict';

const { Buffer } = require('node:buffer');

/**
 * RTP header, zero dependency replacement for the `werift-rtp` equivalent.
 */
class RtpHeader {
  constructor(options = {}) {
    this.version = options.version ?? 2;
    this.padding = options.padding ?? false;
    this.extension = options.extension ?? false;
    this.csrcCount = options.csrcCount ?? 0;
    this.marker = options.marker ?? false;
    this.payloadType = options.payloadType ?? 0;
    this.sequenceNumber = options.sequenceNumber ?? 0;
    this.timestamp = options.timestamp ?? 0;
    this.ssrc = options.ssrc ?? 0;
    this.csrc = options.csrc ?? [];
    this.extensionProfile = options.extensionProfile ?? 0;
    this.extensionLength = options.extensionLength ?? 0;
    this.extensionData = options.extensionData ?? [];
  }
}

/**
 * RTP packet, zero dependency replacement for the `werift-rtp` equivalent.
 */
class RtpPacket {
  constructor(header = new RtpHeader(), payload = null) {
    this.header = header;
    this.payload = payload;
  }

  /**
   * Serializes this packet into a Buffer.
   * @returns {Buffer}
   */
  serialize() {
    const header = this.header;
    const csrcSize = header.csrc.length * 4;
    let extensionsSize = 0;
    if (header.extension) {
      extensionsSize = 4 + header.extensionData.length * 4;
    }
    const hasPadding = header.padding || header.paddingSize !== undefined;
    const payload = this.payload ?? Buffer.alloc(0);
    let paddingSize = 0;
    if (hasPadding) {
      paddingSize = header.paddingSize ?? (((4 - (payload.length % 4)) % 4) || 4);
    }
    const buffer = Buffer.alloc(12 + csrcSize + extensionsSize + payload.length + paddingSize);

    buffer[0] =
      ((header.version & 0x03) << 6) |
      (Number(header.padding) << 5) |
      (Number(header.extension) << 4) |
      (header.csrcCount & 0x0f);
    buffer[1] = (Number(header.marker) << 7) | (header.payloadType & 0x7f);

    buffer.writeUInt16BE(header.sequenceNumber & 0xffff, 2);
    buffer.writeUInt32BE(header.timestamp >>> 0, 4);
    buffer.writeUInt32BE(header.ssrc >>> 0, 8);

    let offset = 12;
    for (const csrc of header.csrc) {
      buffer.writeUInt32BE(csrc >>> 0, offset);
      offset += 4;
    }
    if (header.extension) {
      buffer.writeUInt16BE(header.extensionProfile & 0xffff, offset);
      buffer.writeUInt16BE(header.extensionLength & 0xffff, offset + 2);
      offset += 4;
      for (const data of header.extensionData) {
        if (Buffer.isBuffer(data)) data.copy(buffer, offset);
        else buffer.writeUInt32BE(data >>> 0, offset);
        offset += 4;
      }
    }
    payload.copy(buffer, offset);
    if (paddingSize > 0) {
      buffer[buffer.length - 1] = paddingSize;
    }
    return buffer;
  }

  /**
   * Parses a Buffer into an RtpPacket.
   * @param {Buffer} buffer The packet buffer
   * @returns {RtpPacket}
   */
  static deSerialize(buffer) {
    const header = new RtpHeader();
    const firstByte = buffer[0];
    header.version = (firstByte >> 6) & 0x03;
    header.padding = Boolean((firstByte >> 5) & 0x01);
    header.extension = Boolean((firstByte >> 4) & 0x01);
    header.csrcCount = firstByte & 0x0f;

    const secondByte = buffer[1];
    header.marker = Boolean((secondByte >> 7) & 0x01);
    header.payloadType = secondByte & 0x7f;
    header.sequenceNumber = buffer.readUInt16BE(2);
    header.timestamp = buffer.readUInt32BE(4);
    header.ssrc = buffer.readUInt32BE(8);

    let offset = 12;
    for (let i = 0; i < header.csrcCount; i++) {
      header.csrc.push(buffer.readUInt32BE(offset));
      offset += 4;
    }
    if (header.extension) {
      header.extensionProfile = buffer.readUInt16BE(offset);
      header.extensionLength = buffer.readUInt16BE(offset + 2);
      offset += 4;
      for (let i = 0; i < header.extensionLength; i++) {
        header.extensionData.push(buffer.readUInt32BE(offset));
        offset += 4;
      }
    }

    let end = buffer.length;
    let paddingSize = 0;
    if (header.padding) {
      paddingSize = buffer[buffer.length - 1];
      end -= paddingSize;
    }
    header.paddingSize = paddingSize;
    const payload = end > offset ? buffer.subarray(offset, end) : null;
    return new RtpPacket(header, payload);
  }
}

module.exports = { RtpPacket, RtpHeader };
