"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RgdDataType = void 0;
exports.dataTypeName = dataTypeName;
exports.parseDataType = parseDataType;
/**
 * RGD Data Types - matches Relic's internal type IDs
 */
var RgdDataType;
(function (RgdDataType) {
    RgdDataType[RgdDataType["Float"] = 0] = "Float";
    RgdDataType[RgdDataType["Integer"] = 1] = "Integer";
    RgdDataType[RgdDataType["Bool"] = 2] = "Bool";
    RgdDataType[RgdDataType["String"] = 3] = "String";
    RgdDataType[RgdDataType["WString"] = 4] = "WString";
    RgdDataType[RgdDataType["Table"] = 100] = "Table";
    RgdDataType[RgdDataType["TableInt"] = 101] = "TableInt";
    RgdDataType[RgdDataType["NoData"] = 254] = "NoData";
})(RgdDataType || (exports.RgdDataType = RgdDataType = {}));
/**
 * Get human-readable name for data type
 */
function dataTypeName(type) {
    switch (type) {
        case RgdDataType.Float: return 'float';
        case RgdDataType.Integer: return 'int';
        case RgdDataType.Bool: return 'bool';
        case RgdDataType.String: return 'string';
        case RgdDataType.WString: return 'wstring';
        case RgdDataType.Table: return 'table';
        case RgdDataType.TableInt: return 'table_int';
        case RgdDataType.NoData: return 'nodata';
        default: return `unknown(${type})`;
    }
}
/**
 * Parse data type from name
 */
function parseDataType(name) {
    switch (name.toLowerCase()) {
        case 'float': return RgdDataType.Float;
        case 'int':
        case 'integer': return RgdDataType.Integer;
        case 'bool':
        case 'boolean': return RgdDataType.Bool;
        case 'string': return RgdDataType.String;
        case 'wstring':
        case 'unicode': return RgdDataType.WString;
        case 'table': return RgdDataType.Table;
        case 'table_int': return RgdDataType.TableInt;
        case 'nodata': return RgdDataType.NoData;
        default: throw new Error(`Unknown data type: ${name}`);
    }
}
