"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const yargs_1 = require("yargs");
const config_1 = require("../config");
const adapter_1 = __importDefault(require("../adapter"));
exports.command = 'diff';
exports.desc = 'Show the changes between the cds data model and the database';
exports.builder = {
    service: {
        alias: 's',
        type: yargs_1.array,
        default: ['db'],
    },
    'to-file': {
        alias: 'f',
        type: String,
    },
};
exports.handler = async (argv) => {
    for (const service of argv.service) {
        const options = await (0, config_1.config)(service);
        const adapter = await (0, adapter_1.default)(service, options);
        await adapter.diff(argv.toFile);
    }
};
//# sourceMappingURL=diff.js.map