/** @jest-environment node */

const Knex = require('knex')

const dbType = process.env.WIKI_TEST_DB || 'sqlite'
const connectionUrl = process.env.WIKI_TEST_DB_URL
const clients = { sqlite: 'sqlite3', postgres: 'pg', mysql: 'mysql2', mariadb: 'mysql2' }
if (!clients[dbType]) { throw new Error('Unsupported WIKI_TEST_DB') }
if (dbType !== 'sqlite' && (!connectionUrl || new URL(connectionUrl).pathname !== '/wiki_contribution_test')) {
  throw new Error('Use a dedicated wiki_contribution_test database for migration tests')
}
const migrations = dbType === 'sqlite' ? [
  ['SQLite', require('../../../db/migrations-sqlite/2.5.129')],
  ['shared', require('../../../db/migrations/2.5.129')]
] : [['shared', require('../../../db/migrations/2.5.129')]]

describe.each(migrations)('page redirects migration on a real database (%s)', (_, migration) => {
  let knex
  let ownsSchema = false

  beforeAll(async () => {
    knex = Knex({
      client: clients[dbType],
      connection: dbType === 'sqlite' ? { filename: ':memory:' } : connectionUrl,
      useNullAsDefault: dbType === 'sqlite'
    })
    if (dbType === 'sqlite') { await knex.raw('PRAGMA foreign_keys = ON') }
    for (const table of ['pages', 'pageHistory', 'pageRedirects']) {
      if (await knex.schema.hasTable(table)) {
        throw new Error(`Refusing to modify existing table ${table}; use an empty test database`)
      }
    }
    ownsSchema = true
    global.WIKI = { config: { db: { type: dbType } } }
  })

  beforeEach(async () => {
    await knex.schema.createTable('pages', table => {
      table.increments('id').primary()
      table.string('path').notNullable()
      table.string('localeCode', 5).notNullable()
    })
    await knex.schema.createTable('pageHistory', table => {
      table.increments('id').primary()
      table.integer('pageId')
      table.string('path').notNullable()
      table.string('localeCode', 5)
      table.string('action')
    })
  })

  afterEach(async () => {
    if (ownsSchema) {
      await knex.schema.dropTableIfExists('pageRedirects')
      await knex.schema.dropTableIfExists('pageHistory')
      await knex.schema.dropTableIfExists('pages')
    }
  })

  afterAll(async () => {
    delete global.WIKI
    if (knex) { await knex.destroy() }
  })

  it('backfills only unoccupied paths using the latest move for a surviving page', async () => {
    await knex('pages').insert([
      { id: 1, path: 'current', localeCode: 'en' },
      { id: 2, path: 'occupied', localeCode: 'en' }
    ])
    await knex('pageHistory').insert([
      { id: 1, pageId: 2, path: 'old', localeCode: 'en', action: 'moved' },
      { id: 2, pageId: 1, path: 'old', localeCode: 'en', action: 'moved' },
      { id: 3, pageId: 1, path: 'occupied', localeCode: 'en', action: 'moved' },
      { id: 4, pageId: 999, path: 'deleted', localeCode: 'en', action: 'moved' },
      { id: 5, pageId: 1, path: 'edited', localeCode: 'en', action: 'updated' },
      { id: 6, pageId: 1, path: 'ancien', localeCode: 'fr', action: 'moved' }
    ])
    await migration.up(knex)
    expect(await knex('pageRedirects').select('path', 'localeCode', 'pageId').orderBy('path')).toEqual([
      { path: 'ancien', localeCode: 'fr', pageId: 1 },
      { path: 'old', localeCode: 'en', pageId: 1 }
    ])
  })

  it('enforces uniqueness and cascading deletion and supports down/up', async () => {
    await knex('pages').insert({ id: 1, path: 'current', localeCode: 'en' })
    await migration.up(knex)
    const redirect = { path: 'old', localeCode: 'en', pageId: 1, createdAt: new Date().toISOString() }
    await knex('pageRedirects').insert(redirect)
    await expect(knex('pageRedirects').insert(redirect)).rejects.toThrow()
    await knex('pages').where('id', 1).delete()
    expect(await knex('pageRedirects')).toHaveLength(0)
    await migration.down(knex)
    expect(await knex.schema.hasTable('pageRedirects')).toBe(false)
    await migration.up(knex)
    expect(await knex.schema.hasTable('pageRedirects')).toBe(true)
  })
})
