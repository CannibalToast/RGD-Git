"use strict";
// CSV / flat-map views of an RGD table.
Object.defineProperty(exports, "__esModule", { value: true });
exports.rgdToFlatMap = rgdToFlatMap;
exports.rgdToCsv = rgdToCsv;
exports.csvToRgd = csvToRgd;
const types_1 = require("./types");
const dictionary_1 = require("./dictionary");
const hash_1 = require("./hash");
const textFormat_1 = require("./textFormat");
const REF_HASH = 0x49D60FAE;
/**
 * Convert RGD table to flat key-value pairs (for CSV export)
 */
function rgdToFlatMap(table, prefix = '') {
    const result = new Map();
    for (const entry of table.entries) {
        if (entry.hash === REF_HASH)
            continue;
        const name = entry.name ?? (0, hash_1.hashToHex)(entry.hash);
        const fullPath = prefix ? `${prefix}.${name}` : name;
        if (entry.type === types_1.RgdDataType.Table || entry.type === types_1.RgdDataType.TableInt) {
            const childMap = rgdToFlatMap(entry.value, fullPath);
            for (const [k, v] of childMap) {
                result.set(k, v);
            }
        }
        else {
            result.set(fullPath, { type: entry.type, value: entry.value });
        }
    }
    return result;
}
/**
 * Convert RGD to CSV format
 */
function rgdToCsv(rgdFile) {
    const flatMap = rgdToFlatMap(rgdFile.gameData);
    const lines = [];
    lines.push('Path,Type,Value');
    for (const [path, { type, value }] of flatMap) {
        const typeName = (0, types_1.dataTypeName)(type);
        let valueStr = String(value);
        // Escape CSV
        if (valueStr.includes(',') || valueStr.includes('"') || valueStr.includes('\n')) {
            valueStr = `"${valueStr.replace(/"/g, '""')}"`;
        }
        lines.push(`${path},${typeName},${valueStr}`);
    }
    return lines.join('\n');
}
/**
 * Parse CSV back to RGD structure
 */
function csvToRgd(csv, dict) {
    const lines = csv.split(/\r?\n/);
    const root = { entries: [] };
    // Skip header
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        // Parse CSV line (simple parser, handles quoted values)
        const parts = parseCSVLine(line);
        if (parts.length < 3)
            continue;
        const [path, typeName, ...valueParts] = parts;
        const valueStr = valueParts.join(',');
        const type = (0, types_1.parseDataType)(typeName);
        const value = (0, textFormat_1.parseValue)(type, valueStr);
        // Navigate/create path
        const pathParts = path.split('.');
        let currentTable = root;
        for (let j = 0; j < pathParts.length - 1; j++) {
            const part = pathParts[j];
            const h = (0, hash_1.isHexHash)(part) ? (0, hash_1.hexToHash)(part) : (0, dictionary_1.nameToHash)(dict, part);
            let existingEntry = currentTable.entries.find(e => e.hash === h);
            if (!existingEntry) {
                existingEntry = {
                    hash: h,
                    name: part,
                    type: types_1.RgdDataType.Table,
                    value: { entries: [] }
                };
                currentTable.entries.push(existingEntry);
            }
            currentTable = existingEntry.value;
        }
        // Add the leaf entry
        const leafName = pathParts[pathParts.length - 1];
        const leafHash = (0, hash_1.isHexHash)(leafName) ? (0, hash_1.hexToHash)(leafName) : (0, dictionary_1.nameToHash)(dict, leafName);
        // Check if entry exists
        const existingIdx = currentTable.entries.findIndex(e => e.hash === leafHash);
        const entry = {
            hash: leafHash,
            name: leafName,
            type,
            value
        };
        if (existingIdx >= 0) {
            currentTable.entries[existingIdx] = entry;
        }
        else {
            currentTable.entries.push(entry);
        }
    }
    return root;
}
/**
 * Simple CSV line parser
 */
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    current += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                current += c;
            }
        }
        else {
            if (c === '"') {
                inQuotes = true;
            }
            else if (c === ',') {
                result.push(current);
                current = '';
            }
            else {
                current += c;
            }
        }
    }
    result.push(current);
    return result;
}
