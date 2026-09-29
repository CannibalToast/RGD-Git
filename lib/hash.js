"use strict";
/**
 * Bob Jenkins hash function implementation
 * Used by Relic for RGD key hashing
 * Original: http://burtleburtle.net/bob/hash/evahash.html
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hash = hash;
exports.hashToHex = hashToHex;
exports.hexToHash = hexToHash;
exports.isHexHash = isHexHash;
function mix(a, b, c) {
    // Ensure 32-bit unsigned operations
    const mask = 0xFFFFFFFF;
    a = (a - b - c) >>> 0;
    a = (a ^ (c >>> 13)) >>> 0;
    b = (b - c - a) >>> 0;
    b = (b ^ ((a << 8) & mask)) >>> 0;
    c = (c - a - b) >>> 0;
    c = (c ^ (b >>> 13)) >>> 0;
    a = (a - b - c) >>> 0;
    a = (a ^ (c >>> 12)) >>> 0;
    b = (b - c - a) >>> 0;
    b = (b ^ ((a << 16) & mask)) >>> 0;
    c = (c - a - b) >>> 0;
    c = (c ^ (b >>> 5)) >>> 0;
    a = (a - b - c) >>> 0;
    a = (a ^ (c >>> 3)) >>> 0;
    b = (b - c - a) >>> 0;
    b = (b ^ ((a << 10) & mask)) >>> 0;
    c = (c - a - b) >>> 0;
    c = (c ^ (b >>> 15)) >>> 0;
    return [a >>> 0, b >>> 0, c >>> 0];
}
/**
 * Hash a variable-length key into a 32-bit value
 * @param key - The data to hash (as Buffer or string)
 * @param initval - Initial hash value (default 0)
 * @returns 32-bit hash value
 */
function hash(key, initval = 0) {
    const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
    const length = k.length;
    // Set up the internal state
    let a = 0x9e3779b9 >>> 0; // the golden ratio
    let b = 0x9e3779b9 >>> 0;
    let c = (initval >>> 0); // the previous hash value
    let pos = 0;
    let len = length;
    // Handle most of the key
    while (len >= 12) {
        a = (a + (k[pos] + (k[pos + 1] << 8) + (k[pos + 2] << 16) + (k[pos + 3] << 24))) >>> 0;
        b = (b + (k[pos + 4] + (k[pos + 5] << 8) + (k[pos + 6] << 16) + (k[pos + 7] << 24))) >>> 0;
        c = (c + (k[pos + 8] + (k[pos + 9] << 8) + (k[pos + 10] << 16) + (k[pos + 11] << 24))) >>> 0;
        [a, b, c] = mix(a, b, c);
        pos += 12;
        len -= 12;
    }
    // Handle the last 11 bytes
    c = (c + length) >>> 0;
    // All case statements fall through
    switch (len) {
        case 11: c = (c + (k[pos + 10] << 24)) >>> 0;
        case 10: c = (c + (k[pos + 9] << 16)) >>> 0;
        case 9: c = (c + (k[pos + 8] << 8)) >>> 0;
        // the first byte of c is reserved for the length
        case 8: b = (b + (k[pos + 7] << 24)) >>> 0;
        case 7: b = (b + (k[pos + 6] << 16)) >>> 0;
        case 6: b = (b + (k[pos + 5] << 8)) >>> 0;
        case 5: b = (b + k[pos + 4]) >>> 0;
        case 4: a = (a + (k[pos + 3] << 24)) >>> 0;
        case 3: a = (a + (k[pos + 2] << 16)) >>> 0;
        case 2: a = (a + (k[pos + 1] << 8)) >>> 0;
        case 1: a = (a + k[pos]) >>> 0;
    }
    [a, b, c] = mix(a, b, c);
    return c >>> 0;
}
/**
 * Convert a hash to hex string (0x prefixed, 8 chars)
 */
function hashToHex(h) {
    return '0x' + h.toString(16).toUpperCase().padStart(8, '0');
}
/**
 * Parse a hex hash string to number
 */
function hexToHash(hex) {
    if (hex.startsWith('0x') || hex.startsWith('0X')) {
        hex = hex.slice(2);
    }
    return parseInt(hex, 16) >>> 0;
}
/**
 * Check if a string looks like a hex hash (0xXXXXXXXX)
 */
function isHexHash(str) {
    if (!str.startsWith('0x') && !str.startsWith('0X'))
        return false;
    if (str.length !== 10)
        return false;
    for (let i = 2; i < 10; i++) {
        const c = str[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
            return false;
        }
    }
    return true;
}
