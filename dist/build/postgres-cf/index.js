"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cds_1 = __importDefault(require("@sap/cds"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const BuildTaskHandlerInternal = require('@sap/cds/bin/build/provider/buildTaskHandlerInternal');
const { getHanaDbModuleDescriptor } = require('@sap/cds/bin/deploy/to-hana/mtaUtil');
const { FOLDER_GEN, FILE_EXT_CDS } = require('@sap/cds/bin/build/constants');
const DEBUG = process.env.DEBUG;
const FILE_NAME_MANIFEST_YML = 'manifest.yml';
const DEFAULT_COMPILE_DEST_FOLDER = path_1.default.normalize('src/gen');
const FILE_EXT_CSV = '.csv';
const FILE_NAME_PACKAGE_JSON = 'package.json';
const DEPLOY_CMD = 'npx cds-dbm deploy --load-via delta';
class PostgresCfModuleBuilder extends BuildTaskHandlerInternal {
    /**
     *
     * @param task
     * @param buildOptions
     */
    constructor(task, buildOptions) {
        super('PostgreSQL CF Module Builder', task, buildOptions);
    }
    init() {
        this.task.options.deployCmd = this.task.options.deployCmd || DEPLOY_CMD;
        this.task.options.compileDest = path_1.default.resolve(this.task.dest, this.task.options.compileDest || DEFAULT_COMPILE_DEST_FOLDER);
    }
    get priority() {
        return 1;
    }
    /**
     * name
     */
    async build() {
        const { src, dest } = this.task;
        const destGen = this.isStagingBuild() ? dest : path_1.default.join(dest, FOLDER_GEN);
        const model = await this.model();
        const extCsn = await cds_1.default.compile.to.json(model);
        await this.write(extCsn).to(path_1.default.join(destGen, 'csn.json'));
        await this._copyNativeContent(src, dest);
        await this._writePackageJson();
        await this._writeManifestYml();
        await this._writeDeployShellScript();
        await this._writeUndeployJson(src);
        await this._writeCfIgnore();
        const aptFile = path_1.default.join(__dirname, 'template', 'apt.yml');
        await this.copy(aptFile).to(path_1.default.join(this.task.dest, 'apt.yml'));
    }
    /**
     * Deletes any content that has been created in folder '#this.task.dest/src/gen' by some inplace mode.
     * <br>
     * Note: Content created in staging build will be deleted by the #BuildTaskEngine itself.
     */
    async clean() {
        if (this.isStagingBuild()) {
            return super.clean();
        }
        return fs_extra_1.default.remove(this.task.options.compileDest);
    }
    /**
     * Copies the entire content of the db module located in the given <src> folder to the folder <dest>.
     * '*.csv' and '*.hdbtabledata' files located in a subfolder 'data' or 'csv' will be copied to '<dest>/src/gen/data>'||'<dest>/src/gen/csv>'
     *
     * @param {string} src
     * @param {string} dest
     */
    async _copyNativeContent(src, dest) {
        const dbCsvDir = path_1.default.join(src, 'csv');
        const dbDataDir = path_1.default.join(src, 'data');
        const csvDirs = [dbCsvDir, dbDataDir];
        (await super.copyNativeContent(src, dest, (entry) => {
            if (fs_extra_1.default.statSync(entry).isDirectory()) {
                return true; // using common filter for folders
            }
            const extname = path_1.default.extname(entry);
            return ((extname !== FILE_EXT_CSV && extname !== FILE_EXT_CDS && entry !== this.env.build['outputfile']) ||
                (extname === FILE_EXT_CSV && !entry.startsWith(dbCsvDir) && !entry.startsWith(dbCsvDir)));
        })) || [];
    }
    /**
     *
     */
    async _writePackageJson() {
        var _a, _b;
        const packageJson = path_1.default.join(this.task.src, 'package.json');
        const exists = await fs_extra_1.default.pathExists(packageJson);
        if (DEBUG && exists) {
            this.logger.log(`[cds] - skip create [${this.stripProjectPaths(packageJson)}], already existing`);
        }
        if (this.isStagingBuild() && !exists) {
            const targetPackageJson = await this._readTemplateAsJson(FILE_NAME_PACKAGE_JSON);
            // if specified, add a start command
            if (this.task.options.deployCmd) {
                targetPackageJson.scripts['start'] = this.task.options.deployCmd;
            }
            const rootPackageJsonPath = `${this.buildOptions.root}/package.json`;
            const rootPackageJson = JSON.parse(fs_extra_1.default.readFileSync(rootPackageJsonPath));
            // Merge schema options
            if ((_b = (_a = rootPackageJson.cds) === null || _a === void 0 ? void 0 : _a.migrations) === null || _b === void 0 ? void 0 : _b.schema) {
                targetPackageJson.cds.migrations.schema = rootPackageJson.cds.migrations.schema;
            }
            // Update dependency versions
            const dependencies = rootPackageJson.dependencies;
            for (const dependency in dependencies) {
                if (targetPackageJson.dependencies[dependency] &&
                    !((typeof dependencies[dependency] === 'string' && dependencies[dependency].startsWith('.')) ||
                        dependencies[dependency].startsWith('file:'))) {
                    targetPackageJson.dependencies[dependency] = rootPackageJson.dependencies[dependency];
                }
            }
            await this.write(targetPackageJson).to(path_1.default.join(this.task.dest, FILE_NAME_PACKAGE_JSON));
        }
    }
    /**
     *
     */
    async _writeDeployShellScript() {
        const deployFile = path_1.default.join(__dirname, 'template', 'deploy.sh');
        const targetDeployFile = path_1.default.join(this.task.dest, 'deploy.sh');
        await this.copy(deployFile).to(targetDeployFile);
        fs_extra_1.default.appendFileSync(targetDeployFile, this.task.options.deployCmd);
        (0, fs_1.chmodSync)(targetDeployFile, 0o755);
    }
    /**
     *
     * @param src
     */
    async _writeUndeployJson(src) {
        const migrationOptions = cds_1.default.env['migrations']['db'];
        if (migrationOptions.deploy.undeployFile && (0, fs_1.existsSync)(path_1.default.join(src, migrationOptions.deploy.undeployFile))) {
            this.logger.log(`[cds] - ${this.task.for}: copy existing undeploy.json`);
            await this.copy(path_1.default.join(src, migrationOptions.deploy.undeployFile)).to(path_1.default.join(this.task.dest, 'undeploy.json'));
        }
    }
    /**
     *
     */
    async _writeManifestYml() {
        if (!this.isStagingBuild()) {
            return;
        }
        if ((await fs_extra_1.default.pathExists(path_1.default.join(this.task.src, FILE_NAME_MANIFEST_YML))) ||
            (await fs_extra_1.default.pathExists(path_1.default.join(this.task.src, 'manifest.yml')))) {
            if (DEBUG) {
                this.logger.log(`[cds] - ${this.task.for}: skip cf manifest generation, already existing`);
            }
            return;
        }
        try {
            const descriptor = await getHanaDbModuleDescriptor(this.buildOptions.root, path_1.default.basename(this.task.src), this.logger);
            const MANIFEST_YML_CONTENT = `---
applications:
- name: ${descriptor.appName}
path: .
no-route: true
health-check-type: process
memory: 512M
disk_quota: 2G
buildpacks:
  - https://github.com/cloudfoundry/apt-buildpack#v0.2.2
  - nodejs_buildpack`;
            await this.write(MANIFEST_YML_CONTENT).to(path_1.default.join(this.task.dest, FILE_NAME_MANIFEST_YML));
        }
        catch (e) {
            if (e.name === 'YAMLSyntaxError') {
                this.logger.log(`[cds] - ${this.task.for}: failed to parse [mta.yaml] - skip manifest.yml generation`);
            }
            this.logger.error(e);
        }
    }
    async _writeCfIgnore() {
        const content = `node_modules/\n`;
        await this.write(content).to(path_1.default.join(path_1.default.dirname(this.task.dest), '.cfignore'));
    }
    async _readTemplateAsJson(template) {
        const templatePath = path_1.default.join(__dirname, 'template', template);
        return fs_extra_1.default.readJSON(templatePath, 'utf-8').catch((error) => {
            this.logger.error(`Failed to read template [${templatePath}]`);
            return Promise.reject(error);
        });
    }
}
module.exports = PostgresCfModuleBuilder;
//# sourceMappingURL=index.js.map