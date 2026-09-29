"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRgd = parseRgd;
exports.readRgdFile = readRgdFile;
const fs = __importStar(require("fs"));
const types_1 = require("./types");
const dictionary_1 = require("./dictionary");
const hash_1 = require("./hash");
const RELIC_CHUNKY_SIGNATURE = 'Relic Chunky\x0D\x0A\x1A\x00';
const DATAAEGD_TYPE = 'DATAAEGD';
// Special hash for $REF (reference/inherit)
const REF_HASH = 0x49D60FAE;
/**
 * Binary reader helper
 */
class BinaryReader {
    buffer;
    pos = 0;
    constructor(buffer) {
        this.buffer = buffer;
    }
    get position() { return this.pos; }
    set position(p) { this.pos = p; }
    get length() { return this.buffer.length; }
    get remaining() { return this.buffer.length - this.pos; }
    readBytes(count) {
        const result = this.buffer.subarray(this.pos, this.pos + count);
        this.pos += count;
        return result;
    }
    readUInt32LE() {
        const result = this.buffer.readUInt32LE(this.pos);
        this.pos += 4;
        return result;
    }
    readInt32LE() {
        const result = this.buffer.readInt32LE(this.pos);
        this.pos += 4;
        return result;
    }
    readFloatLE() {
        const result = this.buffer.readFloatLE(this.pos);
        this.pos += 4;
        return result;
    }
    readUInt8() {
        const result = this.buffer.readUInt8(this.pos);
        this.pos += 1;
        return result;
    }
    readString(length) {
        const bytes = this.readBytes(length);
        // Remove null bytes and trim
        let end = bytes.indexOf(0);
        if (end === -1)
            end = length;
        return bytes.subarray(0, end).toString('utf8');
    }
    readNullTerminatedString() {
        const start = this.pos;
        while (this.pos < this.buffer.length && this.buffer[this.pos] !== 0) {
            this.pos++;
        }
        const str = this.buffer.subarray(start, this.pos).toString('utf8');
        this.pos++; // Skip null terminator
        return str;
    }
    readNullTerminatedWString() {
        const start = this.pos;
        while (this.pos + 1 < this.buffer.length) {
            const code = this.buffer.readUInt16LE(this.pos);
            this.pos += 2;
            if (code === 0) {
                // Decode the UTF-16LE range directly from the buffer — avoids
                // allocating an intermediate array and risking stack-overflow
                // on `String.fromCharCode(...chars)` for long strings.
                return this.buffer.toString('utf16le', start, this.pos - 2);
            }
        }
        return this.buffer.toString('utf16le', start, this.pos);
    }
}
/**
 * Read RGD header
 */
function readHeader(reader) {
    const signature = reader.readString(16);
    if (!signature.startsWith('Relic Chunky')) {
        throw new Error(`Invalid RGD signature: expected "Relic Chunky", got "${signature.slice(0, 12)}"`);
    }
    const version = reader.readInt32LE();
    const unknown3 = reader.readInt32LE();
    const header = { signature, version, unknown3 };
    // Version 3 has additional fields
    if (version === 3) {
        header.unknown4 = reader.readInt32LE();
        header.unknown5 = reader.readInt32LE();
        header.unknown6 = reader.readInt32LE();
    }
    return header;
}
/**
 * Read a single chunk header and data
 */
function readChunk(reader, headerVersion) {
    if (reader.remaining < 8)
        return null;
    const type = reader.readString(8);
    const version = reader.readInt32LE();
    const chunkLength = reader.readInt32LE();
    const stringLength = reader.readInt32LE();
    const descriptorString = reader.readString(stringLength);
    // Version 3 has additional fields
    let unknown1 = 0, unknown2 = 0;
    if (headerVersion === 3) {
        unknown1 = reader.readUInt32LE();
        unknown2 = reader.readUInt32LE();
    }
    const crc = reader.readUInt32LE();
    const dataLength = reader.readInt32LE();
    const data = reader.readBytes(dataLength);
    return { type, version, descriptorString, crc, data };
}
/**
 * Process raw RGD data into entries
 */
function processRgdData(reader, dict, parentType = types_1.RgdDataType.Table) {
    const keyCount = reader.readInt32LE();
    const dataOffset = reader.position + (keyCount * 12); // 3 x uint32 per key
    const entries = [];
    let reference;
    for (let i = 0; i < keyCount; i++) {
        const keyStartPos = reader.position;
        const entryHash = reader.readUInt32LE();
        const entryType = reader.readUInt32LE();
        const dataOffsetRel = reader.readUInt32LE();
        // Save position and seek to data
        const savedPos = reader.position;
        reader.position = dataOffset + dataOffsetRel;
        // Resolve hash to name. The dictionary pre-populates numeric keys
        // 0..10000, so the previous TableInt brute-force (10k hash() calls per
        // miss) is no longer needed — any TableInt index within that range is
        // already resolved here.
        const name = (0, dictionary_1.hashToName)(dict, entryHash);
        // Read value based on type
        let value;
        switch (entryType) {
            case types_1.RgdDataType.Float:
                value = reader.readFloatLE();
                break;
            case types_1.RgdDataType.Integer:
                value = reader.readUInt32LE();
                break;
            case types_1.RgdDataType.Bool:
                value = reader.readUInt8() !== 0;
                break;
            case types_1.RgdDataType.String:
                value = reader.readNullTerminatedString();
                break;
            case types_1.RgdDataType.WString:
                value = reader.readNullTerminatedWString();
                break;
            case types_1.RgdDataType.Table:
            case types_1.RgdDataType.TableInt:
                value = processRgdData(reader, dict, entryType);
                break;
            default:
                throw new Error(`Unknown RGD data type: ${entryType}`);
        }
        // Check for $REF special entry
        if (entryHash === REF_HASH) {
            if (typeof value === 'string') {
                reference = value;
            }
        }
        // Restore position
        reader.position = savedPos;
        const entry = {
            hash: entryHash,
            name: name ?? (0, hash_1.hashToHex)(entryHash),
            type: entryType === types_1.RgdDataType.TableInt ? types_1.RgdDataType.Table : entryType,
            value
        };
        entries.push(entry);
    }
    return { entries, reference };
}
/**
 * Parse an RGD file from a buffer
 */
function parseRgd(buffer, dict) {
    const reader = new BinaryReader(buffer);
    // Read header
    const header = readHeader(reader);
    // Read chunks
    const chunks = [];
    let dataChunk = null;
    while (reader.remaining >= 8) {
        const chunk = readChunk(reader, header.version);
        if (!chunk)
            break;
        chunks.push(chunk);
        if (chunk.type === DATAAEGD_TYPE && !dataChunk) {
            dataChunk = chunk;
        }
    }
    if (!dataChunk) {
        throw new Error('No DATAAEGD chunk found in RGD file');
    }
    // Process the data chunk
    const dataReader = new BinaryReader(dataChunk.data);
    const gameData = processRgdData(dataReader, dict);
    return { header, chunks, gameData };
}
/**
 * Read and parse an RGD file from disk
 */
function readRgdFile(filePath, dict) {
    const buffer = fs.readFileSync(filePath);
    return parseRgd(buffer, dict);
}
