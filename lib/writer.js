"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function (o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function () { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function (o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function (o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function (o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function (o) {
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
exports.buildRgd = buildRgd;
exports.writeRgdFile = writeRgdFile;
exports.createEntry = createEntry;
exports.createTable = createTable;
const fs = __importStar(require("fs"));
const types_1 = require("./types");
const dictionary_1 = require("./dictionary");
const RELIC_CHUNKY_SIGNATURE = 'Relic Chunky\x0D\x0A\x1A\x00';
const REF_HASH = 0x49D60FAE;
/**
 * Binary writer helper
 */
class BinaryWriter {
    chunks = [];
    currentChunk;
    pos = 0;
    totalSize = 0;
    constructor(initialSize = 4096) {
        this.currentChunk = Buffer.alloc(initialSize);
    }
    ensureCapacity(bytes) {
        if (this.pos + bytes > this.currentChunk.length) {
            // Save current chunk and create a new one
            this.chunks.push(this.currentChunk.subarray(0, this.pos));
            this.totalSize += this.pos;
            const newSize = Math.max(this.currentChunk.length * 2, bytes * 2);
            this.currentChunk = Buffer.alloc(newSize);
            this.pos = 0;
        }
    }
    get position() {
        return this.totalSize + this.pos;
    }
    writeBytes(data) {
        this.ensureCapacity(data.length);
        data.copy(this.currentChunk, this.pos);
        this.pos += data.length;
    }
    writeUInt32LE(value) {
        this.ensureCapacity(4);
        this.currentChunk.writeUInt32LE(value >>> 0, this.pos);
        this.pos += 4;
    }
    writeInt32LE(value) {
        this.ensureCapacity(4);
        this.currentChunk.writeInt32LE(value, this.pos);
        this.pos += 4;
    }
    writeFloatLE(value) {
        this.ensureCapacity(4);
        this.currentChunk.writeFloatLE(value, this.pos);
        this.pos += 4;
    }
    writeUInt8(value) {
        this.ensureCapacity(1);
        this.currentChunk.writeUInt8(value, this.pos);
        this.pos += 1;
    }
    writeString(str, length) {
        const buf = Buffer.from(str, 'utf8');
        if (length !== undefined) {
            const padded = Buffer.alloc(length);
            buf.copy(padded, 0, 0, Math.min(buf.length, length));
            this.writeBytes(padded);
        }
        else {
            this.writeBytes(buf);
        }
    }
    writeNullTerminatedString(str) {
        const buf = Buffer.from(str + '\0', 'utf8');
        this.writeBytes(buf);
    }
    writeNullTerminatedWString(str) {
        const buf = Buffer.alloc((str.length + 1) * 2);
        for (let i = 0; i < str.length; i++) {
            buf.writeUInt16LE(str.charCodeAt(i), i * 2);
        }
        buf.writeUInt16LE(0, str.length * 2);
        this.writeBytes(buf);
    }
    writePadding(alignment) {
        const pos = this.position;
        const padding = (alignment - (pos % alignment)) % alignment;
        if (padding > 0) {
            this.writeBytes(Buffer.alloc(padding));
        }
    }
    toBuffer() {
        // Combine all chunks
        this.chunks.push(this.currentChunk.subarray(0, this.pos));
        return Buffer.concat(this.chunks);
    }
}
/**
 * Calculate CRC32 of data (using zlib)
 */
function crc32(data) {
    // Node's zlib doesn't expose crc32 directly, use a simple implementation
    let crc = 0xFFFFFFFF;
    const table = getCrc32Table();
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
let crc32Table = null;
function getCrc32Table() {
    if (crc32Table)
        return crc32Table;
    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crc32Table[i] = c >>> 0;
    }
    return crc32Table;
}
/**
 * Check if all keys in a table are numeric
 */
function isNumericTable(entries) {
    for (const entry of entries) {
        if (entry.hash === REF_HASH)
            continue; // Skip $REF
        const name = entry.name;
        if (!name || !/^\d+$/.test(name)) {
            return false;
        }
    }
    return true;
}
/**
 * Sort entries for writing
 * Note: entries should have valid hashes before sorting
 */
function sortEntries(entries, numeric, dict) {
    return [...entries].sort((a, b) => {
        if (numeric) {
            const aNum = parseInt(a.name ?? '0', 10);
            const bNum = parseInt(b.name ?? '0', 10);
            return aNum - bNum;
        }
        // Use hash directly, computing from name if needed
        const aHash = a.hash || (a.name ? (0, dictionary_1.nameToHash)(dict, a.name) : 0);
        const bHash = b.hash || (b.name ? (0, dictionary_1.nameToHash)(dict, b.name) : 0);
        return aHash - bHash;
    });
}
/**
 * Get the byte alignment for a data type
 */
function getAlignment(type) {
    switch (type) {
        case types_1.RgdDataType.Float: return 4;
        case types_1.RgdDataType.Integer: return 4;
        case types_1.RgdDataType.WString: return 2;
        case types_1.RgdDataType.Table:
        case types_1.RgdDataType.TableInt: return 4;
        default: return 1;
    }
}
/**
 * Write RGD table data recursively
 */
function writeTableData(table, dict) {
    const writer = new BinaryWriter();
    // Filter out NoData entries
    const validEntries = table.entries.filter(e => e.type !== types_1.RgdDataType.NoData);
    // Check if numeric table
    const numeric = isNumericTable(validEntries);
    const sorted = sortEntries(validEntries, numeric, dict);
    // Write key count
    writer.writeInt32LE(sorted.length);
    // Calculate data section offset
    const keysSectionSize = sorted.length * 12;
    // We need to write keys first, then data
    // But keys reference offsets into data section
    // So we build the data section first to know offsets
    const dataBuffers = [];
    let dataOffset = 0;
    for (const entry of sorted) {
        // Calculate padding for alignment
        const alignment = getAlignment(entry.type);
        const padding = (alignment - (dataOffset % alignment)) % alignment;
        dataOffset += padding;
        const entryDataOffset = dataOffset;
        let entryData;
        switch (entry.type) {
            case types_1.RgdDataType.Float:
                entryData = Buffer.alloc(4);
                entryData.writeFloatLE(entry.value, 0);
                break;
            case types_1.RgdDataType.Integer:
                entryData = Buffer.alloc(4);
                entryData.writeUInt32LE(entry.value >>> 0, 0);
                break;
            case types_1.RgdDataType.Bool:
                entryData = Buffer.alloc(1);
                entryData.writeUInt8(entry.value ? 1 : 0, 0);
                break;
            case types_1.RgdDataType.String:
                entryData = Buffer.from(entry.value + '\0', 'utf8');
                break;
            case types_1.RgdDataType.WString: {
                const str = entry.value;
                entryData = Buffer.alloc((str.length + 1) * 2);
                for (let i = 0; i < str.length; i++) {
                    entryData.writeUInt16LE(str.charCodeAt(i), i * 2);
                }
                entryData.writeUInt16LE(0, str.length * 2);
                break;
            }
            case types_1.RgdDataType.Table:
            case types_1.RgdDataType.TableInt:
                entryData = writeTableData(entry.value, dict);
                break;
            default:
                throw new Error(`Cannot write data type: ${entry.type}`);
        }
        dataBuffers.push({ offset: entryDataOffset, data: entryData, alignment });
        dataOffset += entryData.length;
    }
    // Now write keys
    for (let i = 0; i < sorted.length; i++) {
        const entry = sorted[i];
        const typeToWrite = (entry.type === types_1.RgdDataType.Table && numeric)
            ? types_1.RgdDataType.TableInt
            : entry.type;
        // Use existing hash, or compute from name if hash is 0
        let entryHash = entry.hash;
        if (entryHash === 0 && entry.name) {
            entryHash = (0, dictionary_1.nameToHash)(dict, entry.name);
        }
        writer.writeUInt32LE(entryHash);
        writer.writeUInt32LE(typeToWrite);
        writer.writeUInt32LE(dataBuffers[i].offset);
    }
    // Write data section with padding
    let currentOffset = 0;
    for (const { offset, data, alignment } of dataBuffers) {
        // Write padding
        const padding = offset - currentOffset;
        if (padding > 0) {
            writer.writeBytes(Buffer.alloc(padding));
        }
        writer.writeBytes(data);
        currentOffset = offset + data.length;
    }
    return writer.toBuffer();
}
/**
 * Build an RGD file from data
 */
function buildRgd(gameData, dict, version = 1) {
    const writer = new BinaryWriter();
    // Write header
    writer.writeString(RELIC_CHUNKY_SIGNATURE, 16);
    writer.writeInt32LE(version);
    writer.writeInt32LE(1); // unknown3
    if (version === 3) {
        writer.writeInt32LE(0x24); // unknown4
        writer.writeInt32LE(0x1C); // unknown5
        writer.writeInt32LE(0x01); // unknown6
    }
    // Build data chunk content
    const dataContent = writeTableData(gameData, dict);
    const dataCrc = crc32(dataContent);
    // Write DATAAEGD chunk
    writer.writeString('DATAAEGD', 8);
    writer.writeInt32LE(1); // chunk version
    const descriptorString = '';
    const chunkLength = descriptorString.length + 8 + dataContent.length; // stringLen + crc + dataLen + data
    writer.writeInt32LE(chunkLength);
    writer.writeInt32LE(descriptorString.length);
    if (descriptorString.length > 0) {
        writer.writeString(descriptorString);
    }
    if (version === 3) {
        writer.writeUInt32LE(0xFFFFFFFF); // unknown1
        writer.writeUInt32LE(0); // unknown2
    }
    writer.writeUInt32LE(dataCrc);
    writer.writeInt32LE(dataContent.length);
    writer.writeBytes(dataContent);
    return writer.toBuffer();
}
/**
 * Write an RGD file to disk
 */
function writeRgdFile(filePath, gameData, dict, version = 1) {
    const buffer = buildRgd(gameData, dict, version);
    fs.writeFileSync(filePath, buffer);
}
/**
 * Create an RgdEntry from values
 */
function createEntry(name, type, value, dict) {
    const h = (0, dictionary_1.nameToHash)(dict, name);
    return {
        hash: h,
        name,
        type,
        value
    };
}
/**
 * Create an empty RgdTable
 */
function createTable(reference) {
    return {
        entries: [],
        reference
    };
}
