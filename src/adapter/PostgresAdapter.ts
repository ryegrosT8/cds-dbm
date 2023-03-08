import { Client, ClientConfig } from 'pg'
import fs from 'fs'
import liquibase from '../liquibase'
import { BaseAdapter } from './BaseAdapter'
import { liquibaseOptions } from './../config'
import { PostgresDatabase } from './../types/PostgresDatabase'
import { ChangeLog } from '../ChangeLog'
import { ViewDefinition } from '../types/AdapterTypes'

const getCredentialsForClient = (credentials) => {
  if (typeof credentials.username !== 'undefined') {
    credentials.user = credentials.username
  }
  if (typeof credentials.hostname !== 'undefined') {
    credentials.host = credentials.hostname
  }
  if (typeof credentials.dbname !== 'undefined') {
    credentials.database = credentials.dbname
  }
  const config: ClientConfig = {
    user: credentials.user,
    password: credentials.password,
    host: credentials.host,
    database: credentials.database,
    port: credentials.port,
  }
  if (credentials.sslrootcert) {
    config.ssl = {
      rejectUnauthorized: false,
      ca: credentials.sslrootcert,
    }
  }
  return config
}

export class PostgresAdapter extends BaseAdapter {
  async getViewDefinition(viewName: string): Promise<ViewDefinition> {
    const credentials = this.options.service.credentials
    const client = new Client(getCredentialsForClient(credentials))
    await client.connect()
    const { rows } = await client.query(
      `SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = 'public' AND table_name = $1 ORDER BY table_name;`,
      [viewName]
    )
    await client.end()

    const viewDefinition: ViewDefinition = {
      name: viewName,
      definition: rows[0]?.view_definition?.replace(/public./g, ''),
    }

    return viewDefinition
  }

  /**
   * @override
   * @param changelog
   */
  beforeDeploy(changelog: ChangeLog) {
    this._removePostgreSystemViewsFromChangelog(changelog)
    if(this.options.migrations.rlsMultiTenant){
      this._addRlsSettingsToChangeLog(changelog)
    }
  }

  /**
   *
   * @override
   * @param table
   */
  async _truncateTable(table: any): Promise<void> {
    const credentials = this.options.service.credentials
    const client = new Client(getCredentialsForClient(credentials))

    await client.connect()
    await client.query(`TRUNCATE ${table} RESTART IDENTITY`)
    client.end()
  }
  /**
   *
   */
  async _dropViewsFromCloneDatabase(): Promise<void> {
    const credentials = this.options.service.credentials
    const cloneSchema = this.options.migrations.schema!.clone
    const client = new Client(getCredentialsForClient(credentials))

    await client.connect()
    await client.query(`SET search_path TO ${cloneSchema};`)

    for (const query of this.cdsSQL) {
      const [, table, entity] = query.match(/^\s*CREATE (?:(TABLE)|VIEW)\s+"?([^\s(]+)"?/im) || []
      if (!table) {
        await client.query(`DROP VIEW IF EXISTS ${entity} CASCADE`)
      }
    }

    return client.end()
  }

  /**
   * Returns the liquibase options for the given command.
   *
   * @override
   * @param {string} cmd
   */
  liquibaseOptionsFor(cmd: string): liquibaseOptions {
    const credentials = this.options.service.credentials
    var url = `jdbc:postgresql://${credentials.host || credentials.hostname}:${credentials.port}/${
      credentials.database || credentials.dbname
    }`
    if (credentials.sslrootcert) {
      url += '?ssl=true'
    }

    const liquibaseOptions: liquibaseOptions = {
      username: credentials.user || credentials.username,
      password: this.options.service.credentials.password,
      url: url,
      classpath: `${__dirname}/../../drivers/postgresql-42.3.2.jar`,
      driver: 'org.postgresql.Driver',
    }

    switch (cmd) {
      case 'diffChangeLog':
      case 'diff':
        liquibaseOptions.referenceUrl = liquibaseOptions.url
        liquibaseOptions.referenceUsername = liquibaseOptions.username
        liquibaseOptions.referencePassword = liquibaseOptions.password
        liquibaseOptions.defaultSchemaName = this.options.migrations.schema!.default
        liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema!.reference
        break
      case 'update':
      case 'updateSQL':
      case 'dropAll':
      default:
        break
    }

    return liquibaseOptions
  }

  async _synchronizeCloneDatabase() {
    const credentials = this.options.service.credentials
    const cloneSchema = this.options.migrations.schema!.clone
    const temporaryChangelogFile = `${this.options.migrations.deploy.tmpFile}`

    const client = new Client(getCredentialsForClient(credentials))
    await client.connect()
    await client.query(`DROP SCHEMA IF EXISTS ${cloneSchema} CASCADE`)
    await client.query(`CREATE SCHEMA ${cloneSchema}`)
    await client.end()

    // Basically create a copy of the schema
    let liquibaseOptions = this.liquibaseOptionsFor('diffChangeLog')
    liquibaseOptions.defaultSchemaName = cloneSchema
    liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema!.default
    liquibaseOptions.changeLogFile = temporaryChangelogFile

    await liquibase(liquibaseOptions).run('diffChangeLog')

    // Remove unnecessary stuff
    const diffChangeLog = ChangeLog.fromFile(temporaryChangelogFile)
    this._removePostgreSystemViewsFromChangelog(diffChangeLog)
    diffChangeLog.toFile(temporaryChangelogFile)

    // Now deploy the copy to the clone
    liquibaseOptions = this.liquibaseOptionsFor('update')
    liquibaseOptions.defaultSchemaName = cloneSchema
    liquibaseOptions.changeLogFile = temporaryChangelogFile

    await liquibase(liquibaseOptions).run('update')

    fs.unlinkSync(temporaryChangelogFile)

    return Promise.resolve()
  }


  /**
  * Add RLS settings to change log
  * 
  * Ps.Since liquibase don't detect "SET ROW LEVEL SECURITY" and "POLICY's" on tables 
  * and also is unable to parse default value for column (when is a expression) 
  * when running "diff" between schemas. Had to add all statements directly in changelog. 
  * If in future liquibase become able to "diff" RLS statements, we then 
  * can move the above logic to _deployCdsToReferenceDatabase
   */  
  _addRlsSettingsToChangeLog(changelog: ChangeLog){
    const rlsColumn = this.options.migrations.rlsMultiTenantColumnName || 'tenantId'
    const preStatements : string [] = []
    const postStatements : string [] = []

    // Search into change log for "create table", "add column" and "drop column" of tenant columns
    for (let entry of changelog.data.databaseChangeLog) {
      for (let change of entry.changeSet.changes) {
        for (let action in change) {
          if (action === 'createTable'|| action === 'addColumn' ) {
            let hasTenantColumn: boolean = false

            for (let column of change[action].columns) {
              if (column.column.name === rlsColumn.toLowerCase()){ // Check if have a tenant column on changeset
                hasTenantColumn = true
                column.column.defaultValueComputed = `gettenant()`
                break;
              }
            }
            if (hasTenantColumn) {
                postStatements.push(
                  `ALTER TABLE ${change[action].tableName} ENABLE ROW LEVEL SECURITY; \n` +
                  `ALTER TABLE ${change[action].tableName} FORCE  ROW LEVEL SECURITY; \n` + 
                  `DROP POLICY IF EXISTS tenant_policy_${change[action].tableName} ON ${change[action].tableName} ; \n` +
                  `CREATE POLICY tenant_policy_${change[action].tableName} ON ${change[action].tableName} USING ( ` +
                  `  ${rlsColumn} = getTenant()::varchar(36));`
                )
            }
          }else if((action === 'dropColumn' && change[action].columnName === rlsColumn.toLowerCase()) 
            || action === 'dropTable'){
            // In case of dropTable, the changelog don't have columns info. Best approach is try
            // to drop related policys with "if exists" clause to avoid "NOT CASCADED" drop o table error
            preStatements.push( 
              `ALTER TABLE ${change[action].tableName} DISABLE ROW LEVEL SECURITY; \n` +
              `DROP POLICY IF EXISTS tenant_policy_${change[action].tableName} ON ${change[action].tableName} ;`
              );            
          }else if(action === 'dropDefaultValue' && change[action].columnName === rlsColumn.toLowerCase() ){
            // Diff log will try to drop default value on every interaction
            entry.changeSet.ignore = true // tell liquibase to ignore this statement
          }
        }
      }
    }

    if(preStatements.length > 0 || postStatements.length > 0 ){
      preStatements.push(
        `CREATE OR REPLACE FUNCTION getTenant() RETURNS varchar(36) ` +
        `AS $$ SELECT current_setting('app.current_tenant',true)::character varying(36) $$ `+
        `LANGUAGE SQL;`)              
    }
    preStatements.forEach((statement,seq)=>changelog.addSLQChangeSet(`${new Date().getTime()}-${seq}-before-RLS`,statement,true))
    postStatements.forEach((statement,seq)=>changelog.addSLQChangeSet(`${new Date().getTime()}-${seq}-after-RLS`,statement))

  }

  /**
   * @override
   */
  async _deployCdsToReferenceDatabase() {
    const credentials = this.options.service.credentials
    const referenceSchema = this.options.migrations.schema!.reference
    const client = new Client(getCredentialsForClient(credentials))

    await client.connect()
    await client.query(`DROP SCHEMA IF EXISTS ${referenceSchema} CASCADE`)
    await client.query(`CREATE SCHEMA ${referenceSchema}`)
    await client.query(`SET search_path TO ${referenceSchema};`)

    const serviceInstance = cds.services[this.serviceKey] as PostgresDatabase
    for (const query of this.cdsSQL) {
      await client.query(serviceInstance.cdssql2pgsql(query))
    }

    return client.end()
  }

  /**
   * @override
   */
  async _createDatabase() {
    const clientCredentials = getCredentialsForClient(this.options.service.credentials)
    const { database } = clientCredentials

    // Do not connect directly to the database
    delete clientCredentials.database
    const client = new Client(clientCredentials)

    await client.connect()
    try {
      // Revisit: should be more safe, but does not work
      // await client.query(`CREATE DATABASE $1`, [this.options.service.credentials.database])
      await client.query(`CREATE DATABASE ${database}`)
      this.logger.log(`[cds-dbm] - created database ${database}`)
    } catch (error) {
      switch (error.code) {
        case '42P04': // already exists
          this.logger.log(`[cds-dbm] - database ${database} is already present`)
        case '23505': // concurrent attempt
          break
        default:
          throw error
      }
    }

    client.end()
  }

  /**
   * Removes PostgreSQL specific view statements from the changelog, that may cloud deployments
   * to break.
   *
   * Revisit: Check why this is the case.
   *
   * @param {Changelog} changelog
   */
  private _removePostgreSystemViewsFromChangelog(changelog) {
    for (const changeLog of changelog.data.databaseChangeLog) {
      changeLog.changeSet.changes = changeLog.changeSet.changes.filter((change) => {
        return (
          !(change.createView && change.createView.viewName.includes('pg_stat_statements')) &&
          !(change.dropView && change.dropView.viewName.includes('pg_stat_statements')) &&
          !(change.createView && change.createView.viewName.includes('pg_buffercache')) &&
          !(change.dropView && change.dropView.viewName.includes('pg_buffercache'))
        )
      })
    }
  }
}
