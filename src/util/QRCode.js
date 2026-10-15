'use strict';

/*
 * Zero dependency QR Code encoder (byte mode, versions 1-40, EC levels L/M/Q/H).
 * Implements ISO/IEC 18004 with the well-known Reed-Solomon / mask algorithms.
 * Replacement for the `qrcode` package (only the `toString`/`create` surface is provided).
 */

const ECC_CODEWORDS_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const NUM_ERROR_CORRECTION_BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function getNumRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(version, ecl) {
  return (
    (getNumRawDataModules(version) >> 3) -
    ECC_CODEWORDS_PER_BLOCK[ecl][version - 1] * NUM_ERROR_CORRECTION_BLOCKS[ecl][version - 1]
  );
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonComputeDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

/**
 * Represents a QR code matrix (version 1-40, EC levels L/M/Q/H).
 */
class QRCode {
  constructor(version, ecl = 'L') {
    if (version < 1 || version > 40 || !ECL_FORMAT_BITS.hasOwnProperty(ecl)) {
      throw new RangeError(`Invalid QR version (${version}) or EC level (${ecl}).`);
    }
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.data = [];
    this.mask = -1;
  }

  /**
   * Appends bytes (byte mode) to the payload.
   * @param {string|Buffer} text The content
   * @returns {this}
   */
  addData(text) {
    this.data.push(...new TextEncoder().encode(String(text)));
    return this;
  }

  _setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  _drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this._setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  _getAlignmentPatternPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  _drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this._setFunctionModule(6, i, i % 2 === 0);
      this._setFunctionModule(i, 6, i % 2 === 0);
    }
    this._drawFinderPattern(3, 3);
    this._drawFinderPattern(this.size - 4, 3);
    this._drawFinderPattern(3, this.size - 4);
    const alignPos = this._getAlignmentPatternPositions();
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this._drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }
    this._drawFormatBits(0);
    this._drawVersion();
  }

  _drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this._setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  _drawFormatBits(mask) {
    const data = (ECL_FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) this._setFunctionModule(8, i, getBit(bits, i));
    this._setFunctionModule(8, 7, getBit(bits, 6));
    this._setFunctionModule(8, 8, getBit(bits, 7));
    this._setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this._setFunctionModule(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) this._setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this._setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this._setFunctionModule(8, this.size - 8, true);
  }

  _drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;

    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this._setFunctionModule(a, b, bit);
      this._setFunctionModule(b, a, bit);
    }
  }

  _addEccAndInterleave() {
    const version = this.version;
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.ecl][version - 1];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[this.ecl][version - 1];
    const rawCodewords = getNumRawDataModules(version) >> 3;
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const divisor = reedSolomonComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = this.data.slice(k, k + datLen);
      k += datLen;
      const ecc = reedSolomonComputeRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(Array.from(ecc)));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  _drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  _applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          case 7:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  _getPenaltyScore() {
    let result = 0;
    const size = this.size;

    const addHistory = (currentRunLength, runHistory) => {
      if (runHistory[0] === 0) currentRunLength += size; // Add light border to initial run
      runHistory.pop();
      runHistory.unshift(currentRunLength);
    };
    const countPatterns = runHistory => {
      const n = runHistory[1];
      const core =
        n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
      return (
        (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
        (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
      );
    };
    const terminateAndCount = (currentRunColor, currentRunLength, runHistory) => {
      if (currentRunColor) {
        addHistory(currentRunLength, runHistory);
        currentRunLength = 0;
      }
      currentRunLength += size;
      addHistory(currentRunLength, runHistory);
      return countPatterns(runHistory);
    };

    // Rules 1 & 3: adjacent modules of the same color and finder-like patterns (rows)
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += 3;
          else if (runX > 5) result++;
        } else {
          addHistory(runX, runHistory);
          if (!runColor) result += countPatterns(runHistory) * 40;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += terminateAndCount(runColor, runX, runHistory) * 40;
    }
    // Rules 1 & 3 (columns)
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (this.modules[y][x] === runColor) {
          runY++;
          if (runY === 5) result += 3;
          else if (runY > 5) result++;
        } else {
          addHistory(runY, runHistory);
          if (!runColor) result += countPatterns(runHistory) * 40;
          runColor = this.modules[y][x];
          runY = 1;
        }
      }
      result += terminateAndCount(runColor, runY, runHistory) * 40;
    }

    // Rule 2: 2x2 blocks of the same color
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = this.modules[y][x];
        if (
          color === this.modules[y][x + 1] &&
          color === this.modules[y + 1][x] &&
          color === this.modules[y + 1][x + 1]
        ) {
          result += 3;
        }
      }
    }

    // Rule 4: balance of dark and light modules
    let dark = 0;
    for (const row of this.modules) {
      for (const cell of row) {
        if (cell) dark++;
      }
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }

  /**
   * Computes the final matrix: ECC, interleaving, data placement and best mask.
   * @returns {this}
   */
  make() {
    const dataCapacityBits = getNumDataCodewords(this.version, this.ecl) * 8;
    const bits = [];
    const pushBits = (value, length) => {
      for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };

    pushBits(0x04, 4); // Byte mode
    pushBits(this.data.length, this.version <= 9 ? 8 : 16);
    for (const byte of this.data) pushBits(byte, 8);

    const terminator = Math.min(4, dataCapacityBits - bits.length);
    pushBits(0, terminator);
    pushBits(0, (8 - (bits.length % 8)) % 8);

    for (let padByte = 0xec; bits.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) pushBits(padByte, 8);

    const dataCodewords = new Array(bits.length / 8).fill(0);
    bits.forEach((bit, i) => (dataCodewords[i >>> 3] |= bit << (7 - (i & 7))));
    this.data = dataCodewords;

    this._drawFunctionPatterns();
    const allCodewords = this._addEccAndInterleave();
    this._drawCodewords(allCodewords);

    let bestMask = -1;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      this._applyMask(mask);
      this._drawFormatBits(mask);
      const penalty = this._getPenaltyScore();
      if (penalty < bestPenalty) {
        bestMask = mask;
        bestPenalty = penalty;
      }
      this._applyMask(mask); // Undo mask (XOR is symmetric)
    }
    if (bestMask < 0) throw new Error('QR: failed to select a mask.');
    this._applyMask(bestMask);
    this._drawFormatBits(bestMask);
    this.mask = bestMask;
    return this;
  }

  /**
   * @returns {number} The amount of modules per side
   */
  getModuleCount() {
    return this.size;
  }

  /**
   * @param {number} row The row
   * @param {number} col The column
   * @returns {boolean}
   */
  isDark(row, col) {
    if (row < 0 || row >= this.size || col < 0 || col >= this.size) throw new RangeError('Module coordinates out of range.');
    return this.modules[row][col];
  }
}

/**
 * Creates a QR code for the given text, choosing the smallest version that fits.
 * @param {string} text The content
 * @param {Object} [options] Options
 * @param {'L'|'M'|'Q'|'H'} [options.errorCorrectionLevel='L'] The EC level
 * @returns {QRCode}
 */
function create(text, options = {}) {
  const ecl = options.errorCorrectionLevel ?? 'L';
  const content = new TextEncoder().encode(String(text));
  for (let version = 1; version <= 40; version++) {
    const capacityBits = getNumDataCodewords(version, ecl) * 8;
    const charCountBits = version <= 9 ? 8 : 16;
    if (4 + charCountBits + content.length * 8 <= capacityBits) {
      const qr = new QRCode(version, ecl);
      qr.addData(text);
      return qr.make();
    }
  }
  throw new RangeError('QR: data too long to fit in any version.');
}

/**
 * Renders the QR code as a terminal-friendly string.
 * @param {string} text The content
 * @param {Object|Function} [options] Options or callback
 * @param {Function} [callback] Callback receiving `(error, string)`
 * @returns {void|Promise<string>|string}
 */
function toString(text, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options ?? {};
  const render = () => {
    const qr = create(text, options);
    const size = qr.getModuleCount();
    const margin = options.margin ?? 2;
    const dark = options.dark ?? '██';
    const light = options.light ?? '  ';
    const lines = [];
    const total = size + margin * 2;
    for (let row = 0; row < total; row++) {
      let line = '';
      for (let col = 0; col < total; col++) {
        const inRange = row >= margin && row < margin + size && col >= margin && col < margin + size;
        line += inRange && qr.isDark(row - margin, col - margin) ? dark : light;
      }
      lines.push(line);
    }
    return lines.join('\n');
  };
  if (typeof callback === 'function') {
    try {
      callback(null, render());
    } catch (error) {
      callback(error);
    }
    return undefined;
  }
  return render();
}

module.exports = { QRCode, create, toString };
