const Page = require('../../models/pages')

describe('models/pages historical link rewrites', () => {
  const trx = {}

  const patchQuery = result => {
    const query = {}
    query.patch = jest.fn(() => query)
    query.findById = jest.fn(() => query)
    query.where = jest.fn(() => query)
    query.transacting = jest.fn().mockResolvedValue(result)
    return query
  }

  afterEach(() => {
    delete global.WIKI
  })

  it('loads only Markdown candidates linked to the redirect target', async () => {
    const targetPage = {
      path: 'current-page',
      localeCode: 'en'
    }
    const linkedPageQuery = {}
    const pageLinksQuery = {}
    pageLinksQuery.select = jest.fn(() => pageLinksQuery)
    pageLinksQuery.from = jest.fn(() => pageLinksQuery)
    pageLinksQuery.where = jest.fn(() => pageLinksQuery)
    linkedPageQuery.where = jest.fn(() => linkedPageQuery)
    linkedPageQuery.whereIn = jest.fn((column, candidateQuery) => {
      candidateQuery.call(pageLinksQuery)
      return Promise.resolve([
        {
          id: 10,
          content: '[Historical](/old-page)',
          contentType: 'markdown',
          localeCode: 'en',
          path: 'links'
        },
        {
          id: 11,
          content: '[Current](/current-page)',
          contentType: 'markdown',
          localeCode: 'en',
          path: 'other-links'
        }
      ])
    })

    const rendererQuery = {}
    rendererQuery.findById = jest.fn(() => rendererQuery)
    rendererQuery.select = jest.fn().mockResolvedValue({
      config: { absoluteLinks: false }
    })

    global.WIKI = {
      auth: { checkAccess: jest.fn().mockReturnValue(true) },
      config: {
        host: 'https://wiki.example',
        lang: {
          code: 'en',
          namespacing: false
        }
      },
      models: {
        pageRedirects: {
          resolve: jest.fn().mockResolvedValue(targetPage)
        },
        pages: Page,
        renderers: {
          query: jest.fn(() => rendererQuery)
        }
      }
    }
    global.WIKI.models.pages.query = jest.fn()
      .mockReturnValueOnce(linkedPageQuery)

    const rewrites = await Page.getHistoricalLinkRewrites({
      sourcePath: 'old-page',
      sourceLocale: 'en'
    })

    expect(global.WIKI.models.pageRedirects.resolve).toHaveBeenCalledWith({
      path: 'old-page',
      locale: 'en',
      trx: undefined
    })
    expect(linkedPageQuery.where).toHaveBeenCalledWith('contentType', 'markdown')
    expect(linkedPageQuery.whereIn).toHaveBeenCalledWith('pages.id', expect.any(Function))
    expect(pageLinksQuery.where).toHaveBeenCalledWith({
      'pageLinks.path': targetPage.path,
      'pageLinks.localeCode': targetPage.localeCode
    })
    expect(rewrites).toHaveLength(1)
    expect(rewrites[0]).toEqual(expect.objectContaining({
      content: '[Historical](/current-page)',
      replacements: 1
    }))
  })

  it('recalculates a rewrite from the latest content after a concurrent edit', async () => {
    const originalPage = {
      id: 7,
      authorId: 1,
      content: '[Historical](/old-page)',
      contentType: 'markdown',
      localeCode: 'en',
      path: 'links',
      updatedAt: '2026-08-15T10:00:00.000Z'
    }
    const latestPage = {
      ...originalPage,
      authorId: 2,
      content: 'Concurrent user change\n\n[Historical](/old-page)',
      updatedAt: '2026-08-15T10:00:01.000Z'
    }
    const rewriteOptions = {
      absoluteLinks: false,
      sourceLocale: 'en',
      sourcePath: 'old-page',
      targetLocale: 'en',
      targetPath: 'moved-page'
    }
    const staleRewrite = {
      page: originalPage,
      content: '[Historical](/moved-page)',
      replacements: 1,
      rewriteOptions
    }
    const staleUpdate = patchQuery(0)
    const latestPageQuery = {
      findById: jest.fn(() => latestPageQuery),
      transacting: jest.fn().mockResolvedValue(latestPage)
    }
    const latestUpdate = patchQuery(1)
    const addVersion = jest.fn().mockResolvedValue()

    global.WIKI = {
      auth: { checkAccess: jest.fn().mockReturnValue(true) },
      config: {
        host: 'https://wiki.example',
        lang: {
          code: 'en',
          namespacing: false
        }
      },
      models: {
        knex: {
          client: {
            config: {
              client: 'sqlite3'
            }
          }
        },
        pageHistory: { addVersion },
        pages: Page
      }
    }
    global.WIKI.models.pages.query = jest.fn()
      .mockReturnValueOnce(staleUpdate)
      .mockReturnValueOnce(latestPageQuery)
      .mockReturnValueOnce(latestUpdate)

    const applied = await Page.applyHistoricalLinkRewrites([staleRewrite], {
      authorId: 3,
      trx
    })

    expect(staleUpdate.where).toHaveBeenCalledWith('updatedAt', originalPage.updatedAt)
    expect(staleUpdate.where).toHaveBeenCalledWith('content', originalPage.content)
    expect(latestUpdate.patch).toHaveBeenCalledWith({
      authorId: 3,
      content: 'Concurrent user change\n\n[Historical](/moved-page)'
    })
    expect(addVersion).toHaveBeenCalledWith(expect.objectContaining({
      content: latestPage.content,
      versionDate: latestPage.updatedAt
    }), trx)
    expect(applied).toHaveLength(1)
    expect(applied[0].page).toBe(latestPage)
  })

  it('rewrites exact historical links across supported URL forms', () => {
    global.WIKI = {
      auth: { checkAccess: jest.fn().mockReturnValue(true) },
      config: {
        host: 'https://wiki.example',
        lang: {
          code: 'en',
          namespacing: true
        }
      }
    }
    const page = {
      content: [
        '[Query](/en/old-page?query=value)',
        '[Fragment](/en/old-page#fragment)',
        '[Both](/en/old-page?query=value#fragment)',
        '[Relative](old-page)',
        '[Absolute](/en/old-page)',
        '[Full URL](https://wiki.example/en/old-page)',
        '[Encoded](/en/%6Fld-page)',
        '[Nested query](/en/old-page?return=(one(two))#fragment)',
        '[Reference][historical]',
        '[historical]:',
        '  /en/old-page#definition',
        '<a class="historical" href=/en/old-page?from=html>HTML</a>'
      ].join('\n'),
      localeCode: 'en',
      path: 'home'
    }

    const rewrite = Page.calculateHistoricalLinkRewrite(page, {
      absoluteLinks: false,
      sourceLocale: 'en',
      sourcePath: 'old-page',
      targetLocale: 'de',
      targetPath: 'moved-page'
    })

    expect(rewrite.replacements).toBe(10)
    expect(rewrite.content).toBe([
      '[Query](/de/moved-page?query=value)',
      '[Fragment](/de/moved-page#fragment)',
      '[Both](/de/moved-page?query=value#fragment)',
      '[Relative](/de/moved-page)',
      '[Absolute](/de/moved-page)',
      '[Full URL](https://wiki.example/de/moved-page)',
      '[Encoded](/de/moved-page)',
      '[Nested query](/de/moved-page?return=(one(two))#fragment)',
      '[Reference][historical]',
      '[historical]:',
      '  /de/moved-page#definition',
      '<a class="historical" href=/de/moved-page?from=html>HTML</a>'
    ].join('\n'))
  })

  it('leaves other locales, similar paths and non-links unchanged', () => {
    global.WIKI = {
      auth: { checkAccess: jest.fn().mockReturnValue(true) },
      config: {
        host: 'https://wiki.example',
        lang: {
          code: 'en',
          namespacing: true
        }
      }
    }
    const content = [
      '[Other locale](/fr/old-page)',
      '[Similar suffix](/en/old-page-2)',
      '[Child page](/en/old-page/child)',
      '[Parenthesized path](/en/old-page(foo))',
      '[Asset](/en/old-page.md)',
      '[External](https://other.example/en/old-page)',
      '[Fragment only](#old-page)',
      '\\[Escaped Markdown](/en/old-page)',
      'Plain path: /en/old-page',
      '<a data-href="/en/old-page">Data attribute</a>'
    ].join('\n')

    const rewrite = Page.calculateHistoricalLinkRewrite({
      content,
      localeCode: 'en',
      path: 'home'
    }, {
      absoluteLinks: false,
      sourceLocale: 'en',
      sourcePath: 'old-page',
      targetLocale: 'de',
      targetPath: 'moved-page'
    })

    expect(rewrite).toBeNull()
  })
})
