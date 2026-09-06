const pageResolver = require('../../../graph/resolvers/page')

describe('page restore resolver', () => {
  const context = { req: { user: { id: 1 } } }
  const page = { path: 'current-page', localeCode: 'en' }
  const targetVersion = {
    pageId: 1,
    versionId: 2,
    path: 'old-page',
    locale: 'en',
    content: 'Historical content'
  }

  class PageHistoricalPathCollision extends Error {
    constructor () {
      super('The historical page path is no longer available.')
      this.name = 'PageHistoricalPathCollision'
      this.code = 6014
    }
  }

  const setup = ({ canRestorePath }) => {
    const pageQuery = {
      select: jest.fn(() => pageQuery),
      findById: jest.fn().mockResolvedValue(page)
    }
    const updatePage = jest.fn().mockResolvedValue()
    const checkPath = jest.fn().mockResolvedValue(canRestorePath)
    global.WIKI = {
      Error: { PageHistoricalPathCollision },
      auth: { checkAccess: jest.fn().mockReturnValue(true) },
      models: {
        pageHistory: { getVersion: jest.fn().mockResolvedValue(targetVersion) },
        pageRedirects: { canRestorePath: checkPath },
        pages: {
          query: jest.fn(() => pageQuery),
          updatePage
        }
      }
    }
    return { checkPath, updatePage }
  }

  afterEach(() => {
    delete global.WIKI
  })

  it('fails without restoring content when the requested historical path was claimed', async () => {
    const { updatePage } = setup({ canRestorePath: false })

    const result = await pageResolver.PageMutation.restore(null, {
      pageId: 1,
      versionId: 2,
      restorePath: true
    }, context)

    expect(result.responseResult).toEqual(expect.objectContaining({
      succeeded: false,
      slug: 'PageHistoricalPathCollision'
    }))
    expect(updatePage).not.toHaveBeenCalled()
  })

  it('restores only content when the retry explicitly disables path restoration', async () => {
    const { checkPath, updatePage } = setup({ canRestorePath: false })

    const result = await pageResolver.PageMutation.restore(null, {
      pageId: 1,
      versionId: 2,
      restorePath: false
    }, context)

    expect(result.responseResult.succeeded).toBe(true)
    expect(checkPath).not.toHaveBeenCalled()
    expect(updatePage).toHaveBeenCalledWith(expect.objectContaining({
      path: page.path,
      locale: page.localeCode,
      reclaimOwnHistoricalPath: false
    }))
    expect(updatePage.mock.calls[0][0]).not.toHaveProperty('reuseHistoricalPath')
  })

  it('restores content and path together when the historical path is still available', async () => {
    const { updatePage } = setup({ canRestorePath: true })

    const result = await pageResolver.PageMutation.restore(null, {
      pageId: 1,
      versionId: 2,
      restorePath: true
    }, context)

    expect(result.responseResult.succeeded).toBe(true)
    expect(updatePage).toHaveBeenCalledWith(expect.objectContaining({
      path: targetVersion.path,
      locale: targetVersion.locale,
      reclaimOwnHistoricalPath: true
    }))
    expect(updatePage.mock.calls[0][0]).not.toHaveProperty('reuseHistoricalPath')
  })
})
