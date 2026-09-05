const migrations = [
  ['shared', require('../../../db/migrations/2.5.129')],
  ['SQLite', require('../../../db/migrations-sqlite/2.5.129')]
]

describe.each(migrations)('2.5.129 page redirects migration (%s)', (_, migration) => {
  const createColumn = () => {
    const column = {}
    for (const method of ['primary', 'notNullable', 'unsigned', 'references', 'inTable', 'onDelete']) {
      column[method] = jest.fn(() => column)
    }
    return column
  }

  const createKnex = ({ movedPaths = [], activePages = [] } = {}) => {
    const columns = {}
    const table = {
      increments: jest.fn(name => (columns[name] = createColumn())),
      string: jest.fn(name => (columns[name] = createColumn())),
      integer: jest.fn(name => (columns[name] = createColumn())),
      unique: jest.fn(),
      index: jest.fn()
    }
    const historyQuery = {}
    for (const method of ['select', 'where', 'whereNotNull']) {
      historyQuery[method] = jest.fn(() => historyQuery)
    }
    historyQuery.orderBy = jest.fn().mockResolvedValue(movedPaths)
    const pagesQuery = {
      select: jest.fn().mockResolvedValue(activePages)
    }
    const redirectsQuery = {
      insert: jest.fn().mockResolvedValue()
    }
    const knex = jest.fn(tableName => ({
      pageHistory: historyQuery,
      pages: pagesQuery,
      pageRedirects: redirectsQuery
    })[tableName])
    knex.schema = {
      createTable: jest.fn(async (tableName, callback) => callback(table))
    }
    return { knex, columns, redirectsQuery }
  }

  beforeEach(() => {
    global.WIKI = { config: { db: { type: 'postgres' } } }
  })

  afterEach(() => {
    delete global.WIKI
  })

  it('ignores history for deleted pages without reserving its paths', async () => {
    const { knex, redirectsQuery } = createKnex({
      activePages: [
        { id: 1, path: 'current-page', localeCode: 'en' },
        { id: 2, path: 'occupied', localeCode: 'en' }
      ],
      movedPaths: [
        { id: 4, pageId: 999, path: 'shared-old-path', localeCode: 'en' },
        { id: 3, pageId: 999, path: 'deleted-page-path', localeCode: 'en' },
        { id: 2, pageId: 1, path: 'occupied', localeCode: 'en' },
        { id: 1, pageId: 1, path: 'shared-old-path', localeCode: 'en' }
      ]
    })

    await migration.up(knex)

    expect(redirectsQuery.insert).toHaveBeenCalledTimes(1)
    expect(redirectsQuery.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        path: 'shared-old-path',
        localeCode: 'en',
        pageId: 1
      })
    ])
  })

  it('defines a cascading foreign key to the target page', async () => {
    const { knex, columns } = createKnex()

    await migration.up(knex)

    expect(columns.pageId.references).toHaveBeenCalledWith('id')
    expect(columns.pageId.inTable).toHaveBeenCalledWith('pages')
    expect(columns.pageId.onDelete).toHaveBeenCalledWith('CASCADE')
  })
})
