const pageFixture = require('./helpers/page-fixture')
const Page = require('../../models/pages')
const PageHistory = require('../../models/pageHistory')
const pageResolver = require('../../graph/resolvers/page')

describe('page history path restoration', () => {
  const fixture = pageFixture()
  const { context, insertPage, movePage, updateContent, getPage, getRedirect } = fixture

  const createRevisionAtOldPath = async () => {
    const page = await insertPage('old', 'Original content')
    await movePage(page, 'current')
    const movedVersion = await PageHistory.query().findOne({
      pageId: page.id,
      path: 'old',
      action: 'moved'
    })
    await updateContent(await getPage('current'), 'New content')
    return { page, movedVersion }
  }

  const restore = (page, version, restorePath) => pageResolver.PageMutation.restore(null, {
    pageId: page.id,
    versionId: version.id,
    restorePath
  }, context)

  it('restores content at the current URL by default', async () => {
    const { page, movedVersion } = await createRevisionAtOldPath()

    const result = await restore(page, movedVersion, false)

    expect(result.responseResult.succeeded).toBe(true)
    await expect(getPage('current')).resolves.toMatchObject({
      id: page.id,
      content: 'Original content'
    })
    await expect(getRedirect('old')).resolves.toMatchObject({
      pageId: page.id,
      path: 'current'
    })
  })

  it('reports availability and restores content with its historical URL', async () => {
    const { page, movedVersion } = await createRevisionAtOldPath()

    const version = await pageResolver.PageQuery.version(null, {
      pageId: page.id,
      versionId: movedVersion.id
    }, context)
    expect(version.canRestorePath).toBe(true)

    const result = await restore(page, movedVersion, true)

    expect(result.responseResult.succeeded).toBe(true)
    await expect(getPage('old')).resolves.toMatchObject({
      id: page.id,
      content: 'Original content'
    })
    await expect(getRedirect('old')).resolves.toBeUndefined()
    await expect(getRedirect('current')).resolves.toMatchObject({
      pageId: page.id,
      path: 'old'
    })
  })

  it('cannot use restoration authority to consume another page redirect', async () => {
    const owner = await insertPage('owned-old')
    const restoring = await insertPage('restore-source')
    await movePage(owner, 'owned-current')

    await expect(Page.movePage({
      id: restoring.id,
      destinationLocale: 'en',
      destinationPath: 'owned-old',
      reclaimOwnHistoricalPath: true,
      skipStorage: true,
      user: fixture.user
    })).rejects.toMatchObject({ name: 'PageHistoricalPathCollision' })

    await expect(getPage('restore-source')).resolves.toMatchObject({ id: restoring.id })
    await expect(getRedirect('owned-old')).resolves.toMatchObject({ pageId: owner.id })
  })

  it.each([
    ['manage access to the current URL', target => target.path !== 'current'],
    ['write access to the historical URL', target => target.path !== 'old']
  ])('requires %s before restoring a path', async (description, allowTarget) => {
    const { page, movedVersion } = await createRevisionAtOldPath()
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions, target) => {
      if (permissions.includes('write:pages') && target.path === 'current') { return true }
      return allowTarget(target)
    })
    try {
      const result = await restore(page, movedVersion, true)
      expect(result.responseResult).toMatchObject({ succeeded: false, slug: 'PageMoveForbidden' })
      await expect(getPage('current')).resolves.toMatchObject({ content: 'New content' })
      await expect(getRedirect('old')).resolves.toMatchObject({ pageId: page.id })
    } finally {
      global.WIKI.auth.checkAccess.mockReturnValue(true)
    }
  })

  it('rolls back content, history and redirect changes when restoration fails', async () => {
    const { page, movedVersion } = await createRevisionAtOldPath()
    const historyCount = await PageHistory.query().where('pageId', page.id).resultSize()
    await fixture.knex.raw(`
      CREATE TRIGGER fail_restore_redirect
      BEFORE INSERT ON pageRedirects
      WHEN NEW.path = 'current'
      BEGIN
        SELECT RAISE(FAIL, 'forced restore redirect failure');
      END
    `)
    try {
      const result = await restore(page, movedVersion, true)
      expect(result.responseResult.succeeded).toBe(false)
      await expect(getPage('current')).resolves.toMatchObject({
        id: page.id,
        content: 'New content'
      })
      await expect(getPage('old')).resolves.toBeUndefined()
      await expect(getRedirect('old')).resolves.toMatchObject({ pageId: page.id })
      await expect(PageHistory.query().where('pageId', page.id).resultSize()).resolves.toBe(historyCount)
    } finally {
      await fixture.knex.raw('DROP TRIGGER IF EXISTS fail_restore_redirect')
    }
  })

  it.each([
    ['rendering', () => Page.renderPage.mockRejectedValueOnce(new Error('forced render failure'))],
    ['search indexing', () => global.WIKI.data.searchEngine.updated.mockRejectedValueOnce(new Error('forced search failure'))],
    ['storage synchronization', () => global.WIKI.models.storage.pageEvent.mockRejectedValueOnce(new Error('forced storage failure'))]
  ])('keeps a committed restoration when post-commit %s fails', async (operation, failOperation) => {
    const { page, movedVersion } = await createRevisionAtOldPath()
    jest.clearAllMocks()
    failOperation()

    const result = await restore(page, movedVersion, true)

    expect(result.responseResult.succeeded).toBe(false)
    await expect(getPage('old')).resolves.toMatchObject({
      id: page.id,
      content: 'Original content'
    })
    await expect(getRedirect('current')).resolves.toMatchObject({ pageId: page.id, path: 'old' })
  })
})
