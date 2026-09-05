const Knex = require('knex')
const { Model } = require('objection')

const ErrorClasses = require('../../../helpers/error')
const Page = require('../../../models/pages')
const PageHistory = require('../../../models/pageHistory')
const Comment = require('../../../models/comments')
const PageLink = require('../../../models/pageLinks')
const Renderer = require('../../../models/renderers')
const Tag = require('../../../models/tags')
const htmlCoreRenderer = require('../../../modules/rendering/html-core/renderer')
const pageResolver = require('../../../graph/resolvers/page')
const commonRouter = require('../../../controllers/common')

module.exports = function pageFixture () {
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
      table.json('extra').notNullable().defaultTo('{}')
      table.string('editorKey')
      table.string('localeCode', 5)
      table.integer('authorId').unsigned()
      table.integer('creatorId').unsigned()
      table.unique(['path', 'localeCode'])
    })
    await knex.schema.createTable('comments', table => {
      table.increments('id').primary()
      table.integer('pageId').references('id').inTable('pages')
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
      toc: [],
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

  const requestHistoricalPath = async path => {
    const route = commonRouter.stack
      .find(layer => layer.route && layer.route.path === '/*')
      .route.stack[0].handle
    const response = {
      headers: {},
      set: jest.fn((name, value) => {
        response.headers[name] = value
        return response
      }),
      redirect: jest.fn((status, location) => ({ status, location }))
    }
    const request = {
      path: `/${path}`,
      query: {},
      user,
      i18n: { changeLanguage: jest.fn() }
    }
    await route(request, response, err => {
      throw err
    })
    return response
  }

  beforeAll(async () => {
    knex = Knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await knex.raw('PRAGMA foreign_keys = ON')
    Model.knex(knex)
    await createSchema()

    global.WIKI = {
      Error: ErrorClasses,
      auth: {
        checkAccess: jest.fn().mockReturnValue(true),
        getEffectivePermissions: jest.fn()
      },
      config: {
        db: { type: 'sqlite' },
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
    delete global.WIKI
    Model.knex(null)
    await knex.destroy()
  })

  return { user, context, insertPage, movePage, updateContent, getPage, renderLink, requestHistoricalPath, get knex () { return knex } }
}
