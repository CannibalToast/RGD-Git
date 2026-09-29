"use strict";
/**
 * RGD Text Format - Human-readable format for editing RGD files
 *
 * Format:
 *   # RGD Text Format v1.0
 *   # Source: filename.rgd
 *
 *   GameData {
 *     $REF = "path/to/inherit.lua"
 *     key_name: float = 1.5
 *     another_key: string = "value"
 *     bool_key: bool = true
 *     int_key: int = 12345
 *     unicode_key: wstring = "unicode value"
 *
 *     nested_table {
 *       child_key: float = 2.0
 *     }
 *   }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rgdToText = rgdToText;
exports.unescapeString = unescapeString;
exports.textToRgd = textToRgd;
exports.rgdToFlatMap = rgdToFlatMap;
exports.rgdToCsv = rgdToCsv;
exports.csvToRgd = csvToRgd;
const types_1 = require("./types");
const dictionary_1 = require("./dictionary");
const hash_1 = require("./hash");
const REF_HASH = 0x49D60FAE;
/**
 * Convert RGD file to text format
 */
function rgdToText(rgdFile, sourceName, localeMap) {
    const lines = [];
    lines.push('# RGD Text Format v1.0');
    if (sourceName) {
        lines.push(`# Source: ${sourceName}`);
    }
    lines.push(`# Version: ${rgdFile.header.version}`);
    lines.push('');
    const refStr = rgdFile.gameData.reference ? ` : "${escapeString(rgdFile.gameData.reference)}"` : '';
    lines.push(`GameData${refStr} {`);
    writeTableContents(lines, rgdFile.gameData, 1, localeMap);
    lines.push('}');
    return lines.join('\n');
}
/**
 * Write table contents with indentation
 */
function writeTableContents(lines, table, indent, localeMap) {
    const prefix = '  '.repeat(indent);
    // Sort entries: tables last, others alphabetically
    const sorted = [...table.entries].sort((a, b) => {
        const aIsTable = a.type === types_1.RgdDataType.Table || a.type === types_1.RgdDataType.TableInt;
        const bIsTable = b.type === types_1.RgdDataType.Table || b.type === types_1.RgdDataType.TableInt;
        if (aIsTable !== bIsTable)
            return aIsTable ? 1 : -1;
        // Skip $REF entries in sorting (they go first)
        if (a.hash === REF_HASH)
            return -1;
        if (b.hash === REF_HASH)
            return 1;
        const aName = a.name ?? (0, hash_1.hashToHex)(a.hash);
        const bName = b.name ?? (0, hash_1.hashToHex)(b.hash);
        return aName.localeCompare(bName);
    });
    for (const entry of sorted) {
        // Skip $REF entries (handled above)
        if (entry.hash === REF_HASH)
            continue;
        const name = entry.name ?? (0, hash_1.hashToHex)(entry.hash);
        if (entry.type === types_1.RgdDataType.Table || entry.type === types_1.RgdDataType.TableInt) {
            // Nested table
            const tableValue = entry.value;
            lines.push('');
            if (tableValue.reference) {
                lines.push(`${prefix}${name} : "${escapeString(tableValue.reference)}" {`);
            }
            else {
                lines.push(`${prefix}${name} {`);
            }
            writeTableContents(lines, tableValue, indent + 1, localeMap);
            lines.push(`${prefix}}`);
        }
        else {
            // Simple value
            const typeName = (0, types_1.dataTypeName)(entry.type);
            const valueStr = formatValue(entry.type, entry.value);
            let comment = '';
            if (entry.type === types_1.RgdDataType.WString || entry.type === types_1.RgdDataType.String) {
                const val = entry.value;
                if (val.startsWith('$') && localeMap) {
                    // LocaleManager stores keys without the `$` sigil (see
                    // src/localeLoader.ts). Strip it once; fall back to the
                    // raw key for older maps that still include it.
                    const locEntry = localeMap.get(val.substring(1)) || localeMap.get(val);
                    if (locEntry) {
                        comment = ` - ${locEntry.text}`;
                    }
                }
            }
            lines.push(`${prefix}${name}: ${typeName} = ${valueStr}${comment}`);
        }
    }
}
/**
 * Format a value for text output
 */
function formatValue(type, value) {
    switch (type) {
        case types_1.RgdDataType.Float:
            // Format float with appropriate precision
            const f = value;
            if (Number.isInteger(f)) {
                return f.toFixed(1);
            }
            return f.toString();
        case types_1.RgdDataType.Integer:
            return value.toString();
        case types_1.RgdDataType.Bool:
            return value ? 'true' : 'false';
        case types_1.RgdDataType.String:
        case types_1.RgdDataType.WString:
            return `"${escapeString(value)}"`;
        default:
            return String(value);
    }
}
/**
 * Escape string for text format
 */
function escapeString(str) {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}
/**
 * Unescape string from text format
 */
function unescapeString(str) {
    return str.replace(/\\(.)/g, (match, char) => {
        switch (char) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case '"': return '"';
            case '\\': return '\\';
            default: return match;
        }
    });
}
/**
 * Parse text format back to RGD structure
 */
function textToRgd(text, dict) {
    const lines = text.split(/\r?\n/);
    let version = 1;
    let lineNum = 0;
    // Parse header comments
    while (lineNum < lines.length) {
        const line = lines[lineNum].trim();
        if (line.startsWith('#')) {
            const versionMatch = line.match(/# Version:\s*(\d+)/);
            if (versionMatch) {
                version = parseInt(versionMatch[1], 10);
            }
            lineNum++;
        }
        else if (line === '') {
            lineNum++;
        }
        else {
            break;
        }
    }
    // Expect "GameData {" or "GameData : \"ref\" {"
    const gameDataLine = lines[lineNum]?.trim();
    const gameDataMatch = gameDataLine?.match(/^GameData\s*(?::\s*"([^"]+)")?\s*\{$/);
    if (!gameDataMatch) {
        throw new Error(`Line ${lineNum + 1}: Expected "GameData {", got "${gameDataLine}"`);
    }
    let gameDataRef;
    if (gameDataMatch[1]) {
        gameDataRef = unescapeString(gameDataMatch[1]);
    }
    lineNum++;
    const { table, endLine } = parseTableContents(lines, lineNum, dict);
    if (gameDataRef) {
        table.reference = gameDataRef;
        // Add $REF entry for consistency if not already present
        if (!table.entries.some(e => e.hash === REF_HASH)) {
            table.entries.unshift({
                hash: REF_HASH,
                name: '$REF',
                type: types_1.RgdDataType.String,
                value: gameDataRef
            });
        }
    }
    return { gameData: table, version };
}
/**
 * Parse table contents from lines
 */
function parseTableContents(lines, startLine, dict) {
    const entries = [];
    let reference;
    let lineNum = startLine;
    while (lineNum < lines.length) {
        const line = lines[lineNum].trim();
        // Skip empty lines
        if (line === '' || line.startsWith('#')) {
            lineNum++;
            continue;
        }
        // End of table
        if (line === '}') {
            break;
        }
        // $REF = "value"
        if (line.startsWith('$REF')) {
            const match = line.match(/\$REF\s*=\s*"(.*)"/);
            if (match) {
                reference = unescapeString(match[1]);
            }
            lineNum++;
            continue;
        }
        // Check for nested table: name { or name : "ref" {
        const tableMatch = line.match(/^(\S+)\s*(?::\s*"([^"]+)")?\s*\{$/);
        if (tableMatch) {
            const name = tableMatch[1];
            const tableRef = tableMatch[2] ? unescapeString(tableMatch[2]) : undefined;
            lineNum++;
            const { table: childTable, endLine } = parseTableContents(lines, lineNum, dict);
            lineNum = endLine + 1;
            if (tableRef) {
                childTable.reference = tableRef;
            }
            const h = (0, hash_1.isHexHash)(name) ? (0, hash_1.hexToHash)(name) : (0, dictionary_1.nameToHash)(dict, name);
            const tableEntry = {
                hash: h,
                name: (0, hash_1.isHexHash)(name) ? (0, dictionary_1.hashToName)(dict, h) ?? name : name,
                type: types_1.RgdDataType.Table,
                value: childTable
            };
            // Add $REF entry to child table if it has a reference
            if (tableRef && !childTable.entries.some(e => e.hash === REF_HASH)) {
                childTable.entries.unshift({
                    hash: REF_HASH,
                    name: '$REF',
                    type: types_1.RgdDataType.String,
                    value: tableRef
                });
            }
            entries.push(tableEntry);
            continue;
        }
        // Parse value: name: type = value
        // Robust matching: everything starting with ' -' is a comment.
        // We use a regex that handles quoted strings that might contain dashes.
        const valueMatch = line.match(/^(\S+)\s*:\s*(\w+)\s*=\s*(.+?)(?:\s+-.*)?$/);
        if (valueMatch) {
            const name = valueMatch[1];
            const typeName = valueMatch[2];
            let valueStr = valueMatch[3].trim();
            // Fix for quoted strings that might contain ' -'
            if (valueStr.startsWith('"') && !valueStr.endsWith('"')) {
                // Re-match greedily for the string content
                const greedyMatch = line.match(/^(\S+)\s*:\s*(\w+)\s*=\s*(".*?")(?:\s+-.*)?$/);
                if (greedyMatch) {
                    valueStr = greedyMatch[3];
                }
            }
            const type = (0, types_1.parseDataType)(typeName);
            const value = parseValue(type, valueStr);
            const h = (0, hash_1.isHexHash)(name) ? (0, hash_1.hexToHash)(name) : (0, dictionary_1.nameToHash)(dict, name);
            entries.push({
                hash: h,
                name: (0, hash_1.isHexHash)(name) ? (0, dictionary_1.hashToName)(dict, h) ?? name : name,
                type,
                value
            });
            lineNum++;
            continue;
        }
        throw new Error(`Line ${lineNum + 1}: Cannot parse line: "${line}"`);
    }
    // Add $REF entry if present
    if (reference) {
        entries.unshift({
            hash: REF_HASH,
            name: '$REF',
            type: types_1.RgdDataType.String,
            value: reference
        });
    }
    return { table: { entries, reference }, endLine: lineNum };
}
/**
 * Parse a value string to the appropriate type
 */
function parseValue(type, valueStr) {
    switch (type) {
        case types_1.RgdDataType.Float:
            return parseFloat(valueStr);
        case types_1.RgdDataType.Integer:
            return parseInt(valueStr, 10);
        case types_1.RgdDataType.Bool:
            return valueStr.toLowerCase() === 'true' || valueStr === '1';
        case types_1.RgdDataType.String:
        case types_1.RgdDataType.WString:
            // Remove quotes
            if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
                return unescapeString(valueStr.slice(1, -1));
            }
            return valueStr;
        default:
            return valueStr;
    }
}
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
        const value = parseValue(type, valueStr);
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
