const Knex = require('knex')
const { Model } = require('objection')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ErrorClasses = require('../../../helpers/error')
const Page = require('../../../models/pages')
const PageHistory = require('../../../models/pageHistory')
const Comment = require('../../../models/comments')
const PageRedirect = require('../../../models/pageRedirects')
const PageLink = require('../../../models/pageLinks')
const Renderer = require('../../../models/renderers')
const Tag = require('../../../models/tags')
const htmlCoreRenderer = require('../../../modules/rendering/html-core/renderer')
const pageResolver = require('../../../graph/resolvers/page')
const commonRouter = require('../../../controllers/common')

module.exports = function pageFixture ({ concurrent = false } = {}) {
  let temporaryDirectory
  const dbType = concurrent ? process.env.WIKI_TEST_DB || 'sqlite' : 'sqlite'
  const connectionUrl = process.env.WIKI_TEST_DB_URL
  const clients = { sqlite: 'sqlite3', postgres: 'pg', mysql: 'mysql2', mariadb: 'mysql2' }
  const tables = ['pageTags', 'tags', 'comments', 'pageLinks', 'pageRedirects', 'pageHistory', 'pageTree', 'pages', 'renderers', 'locales', 'editors', 'users']
  let ownsSchema = false
  if (!clients[dbType]) { throw new Error('Unsupported WIKI_TEST_DB') }
  if (dbType !== 'sqlite' && (!connectionUrl || new URL(connectionUrl).pathname !== '/wiki_contribution_test')) {
    throw new Error('Use a dedicated wiki_contribution_test database')
  }
  const user = {
    id: 1,
    name: 'Test User',
    email: 'test@example.com'
  }
  const context = { req: { user } }
  let knex
  let pageSequence = 0

  const createSchema = async () => {
    await knex.schema.createTable('users', table => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.string('email').notNullable()
    })
    await knex.schema.createTable('editors', table => {
      table.string('key').primary()
    })
    await knex.schema.createTable('locales', table => {
      table.string('code', 5).primary()
    })
    await knex.schema.createTable('renderers', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.json('config')
    })
    await knex.schema.createTable('pages', table => {
      table.increments('id').primary()
      table.string('path').notNullable()
      table.string('hash').notNullable()
      table.string('title').notNullable()
      table.string('description')
      table.boolean('isPrivate').notNullable().defaultTo(false)
      table.boolean('isPublished').notNullable().defaultTo(true)
      table.string('privateNS')
      table.string('publishStartDate')
      table.string('publishEndDate')
      table.text('content')
      table.text('render')
      table.json('toc')
      table.string('contentType').notNullable()
      table.string('createdAt').notNullable()
      table.string('updatedAt').notNullable()
      table.json('extra').notNullable()
      table.string('editorKey')
      table.string('localeCode', 5)
      table.integer('authorId').unsigned()
      table.integer('creatorId').unsigned()
    })
    await knex.schema.createTable('comments', table => {
      table.increments('id').primary()
      table.integer('pageId').unsigned().references('id').inTable('pages')
    })
    await knex.schema.createTable('pageHistory', table => {
      table.increments('id').primary()
      table.string('path').notNullable()
      table.string('hash').notNullable()
      table.string('title').notNullable()
      table.string('description')
      table.boolean('isPrivate').notNullable().defaultTo(false)
      table.boolean('isPublished').notNullable().defaultTo(false)
      table.string('publishStartDate')
      table.string('publishEndDate')
      table.text('content')
      table.string('contentType').notNullable()
      table.string('createdAt').notNullable()
      table.string('action').defaultTo('updated')
      table.string('versionDate').notNullable().defaultTo('')
      table.integer('pageId').unsigned()
      table.string('editorKey')
      table.string('localeCode', 5)
      table.integer('authorId').unsigned()
    })
    await require(dbType === 'sqlite' ? '../../../db/migrations-sqlite/2.5.129' : '../../../db/migrations/2.5.129').up(knex)
    await knex.schema.createTable('pageLinks', table => {
      table.increments('id').primary()
      table.integer('pageId').unsigned()
      table.string('path').notNullable()
      table.string('localeCode', 5).notNullable()
    })
    await knex.schema.createTable('tags', table => {
      table.increments('id').primary()
      table.string('tag').notNullable()
      table.string('title')
      table.string('createdAt')
      table.string('updatedAt')
    })
    await knex.schema.createTable('pageTags', table => {
      table.integer('pageId').unsigned()
      table.integer('tagId').unsigned()
    })
    await knex.schema.createTable('pageTree', table => {
      table.integer('id').primary()
      table.integer('pageId').unsigned()
      table.string('title')
    })
  }

  const insertPage = async (path, content = `Content at /${path}`) => {
    pageSequence++
    return Page.query().insert({
      path,
      hash: `hash-${pageSequence}`,
      title: path,
      description: '',
      isPrivate: false,
      isPublished: true,
      publishStartDate: '',
      publishEndDate: '',
      content,
      render: `<p>${content}</p>`,
      toc: '[]',
      contentType: 'markdown',
      extra: {},
      editorKey: 'markdown',
      localeCode: 'en',
      authorId: user.id,
      creatorId: user.id
    })
  }

  const movePage = async (page, destinationPath, reuseHistoricalPath = false) => {
    const result = await pageResolver.PageMutation.move(null, {
      id: page.id,
      destinationLocale: 'en',
      destinationPath,
      reuseHistoricalPath
    }, context)
    expect(result.responseResult.succeeded).toBe(true)
    return result
  }

  const updateContent = (page, content) => {
    return Page.updatePage({
      id: page.id,
      path: page.path,
      locale: page.localeCode,
      title: page.title,
      description: page.description,
      content,
      isPublished: true,
      publishStartDate: '',
      publishEndDate: '',
      tags: [],
      skipStorage: true,
      user
    })
  }

  const getPage = path => Page.query().findOne({ path, localeCode: 'en' })

  const getRedirect = path => PageRedirect.resolve({ path, locale: 'en' })

  const renderLink = async (page, href) => {
    return htmlCoreRenderer.render.call({
      input: `<p><a href="${href}">Link</a></p>`,
      page,
      children: [],
      config: {
        absoluteLinks: true,
        openExternalLinkNewTab: false,
        relAttributeExternalLink: ''
      }
    })
  }

  const requestHistoricalPath = async (path, query = {}) => {
    const route = commonRouter.stack
      .find(layer => layer.route && layer.route.path === '/*')
      .route.stack[0].handle
    const response = {
      headers: {},
      status: jest.fn(() => response),
      render: jest.fn(),
      set: jest.fn((name, value) => {
        response.headers[name] = value
        return response
      }),
      redirect: jest.fn((status, location) => ({ status, location }))
    }
    const request = {
      path: `/${path}`,
      query,
      user,
      i18n: { changeLanguage: jest.fn() }
    }
    await route(request, response, err => {
      throw err
    })
    return response
  }

  beforeAll(async () => {
    if (concurrent && dbType === 'sqlite') {
      temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-concurrency-'))
    }
    knex = Knex({
      client: clients[dbType],
      connection: dbType === 'sqlite' ? { filename: concurrent ? path.join(temporaryDirectory, 'test.sqlite') : ':memory:' } : connectionUrl,
      pool: {
        min: 1,
        max: concurrent ? 3 : 1,
        afterCreate: (connection, done) => {
          if (dbType === 'sqlite') {
            connection.run('PRAGMA foreign_keys = ON', err => done(err, connection))
          } else {
            done(null, connection)
          }
        }
      },
      useNullAsDefault: dbType === 'sqlite'
    })
    if (dbType === 'sqlite') {
      await knex.raw('PRAGMA foreign_keys = ON')
      if (concurrent) { await knex.raw('PRAGMA journal_mode = WAL') }
    }
    for (const table of tables) {
      if (await knex.schema.hasTable(table)) {
        throw new Error(`Refusing to modify existing table ${table}`)
      }
    }
    ownsSchema = true
    Model.knex(knex)
    global.WIKI = { config: { db: { type: dbType } } }
    await createSchema()

    global.WIKI = {
      Error: ErrorClasses,
      auth: {
        checkAccess: jest.fn().mockReturnValue(true),
        getEffectivePermissions: jest.fn()
      },
      config: {
        db: { type: dbType },
        host: 'https://wiki.example',
        lang: { code: 'en', namespacing: false },
        pageExtensions: []
      },
      data: {
        editors: [{ key: 'markdown', contentType: 'markdown' }],
        searchEngine: {
          created: jest.fn().mockResolvedValue(),
          updated: jest.fn().mockResolvedValue(),
          renamed: jest.fn().mockResolvedValue(),
          deleted: jest.fn().mockResolvedValue()
        }
      },
      events: {
        outbound: { emit: jest.fn() }
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      },
      models: {
        knex,
        comments: Comment,
        pageHistory: PageHistory,
        pageLinks: PageLink,
        pageRedirects: PageRedirect,
        pages: Page,
        renderers: Renderer,
        storage: { pageEvent: jest.fn().mockResolvedValue() },
        tags: Tag
      }
    }

    jest.spyOn(Page, 'rebuildTree').mockResolvedValue()
    jest.spyOn(Page, 'renderPage').mockImplementation(async page => {
      await Page.query().patch({ render: `<p>${page.content}</p>` }).findById(page.id)
    })
    jest.spyOn(Page, 'deletePageFromCache').mockResolvedValue()
    jest.spyOn(Page, 'getPage').mockImplementation(({ path, locale }) => {
      return Page.query().findOne({ path, localeCode: locale })
    })
  })

  beforeEach(async () => {
    await knex('comments').delete()
    await knex('pageTags').delete()
    await knex('tags').delete()
    await knex('pageLinks').delete()
    await knex('pageRedirects').delete()
    await knex('pageHistory').delete()
    await knex('pageTree').delete()
    await knex('pages').delete()
    await knex('renderers').delete()
    await knex('locales').delete()
    await knex('editors').delete()
    await knex('users').delete()

    await knex('users').insert(user)
    await knex('editors').insert({ key: 'markdown' })
    await knex('locales').insert({ code: 'en' })
    await knex('renderers').insert({
      key: 'htmlCore',
      isEnabled: true,
      config: JSON.stringify({ absoluteLinks: true })
    })
  })

  afterAll(async () => {
    jest.restoreAllMocks()
    Model.knex(null)
    if (ownsSchema) {
      for (const table of tables) {
        await knex.schema.dropTableIfExists(table)
      }
    }
    await knex.destroy()
    if (temporaryDirectory) { fs.rmSync(temporaryDirectory, { recursive: true }) }
    delete global.WIKI
  })

  return { user, context, insertPage, movePage, updateContent, getPage, getRedirect, renderLink, requestHistoricalPath, get knex () { return knex } }
}
