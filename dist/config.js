"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const config = async (service) => {
    await cds.connect();
    /* Below code block for solve `[cds-dbm] - failed to load model undefined` issue. */
    const _serviceOptions = cds.env.requires[service];
    const _dbInfo = _serviceOptions.kind ? _serviceOptions.kind : {};
    const serviceOptions = { ..._serviceOptions, ...cds.env.requires[_dbInfo] };
    /* end */
    // @ts-ignore
    const migrationOptions = cds.env.migrations[service];
    return {
        migrations: migrationOptions,
        service: serviceOptions,
    };
};
exports.config = config;
//# sourceMappingURL=config.js.map