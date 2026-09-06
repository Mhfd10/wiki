const pageFixture = require('./helpers/page-fixture')
const Page = require('../../models/pages')
const PageHistory = require('../../models/pageHistory')
const PageLink = require('../../models/pageLinks')
const pageResolver = require('../../graph/resolvers/page')

describe('historical path reuse', () => {
  const fixture = pageFixture()
  const { user, context, insertPage, movePage, getPage, getRedirect, renderLink } = fixture

  it('moves back to its own historical path without rewriting links', async () => {
    const page = await insertPage('foo')
    await movePage(page, 'bar')
    const rewriteSpy = jest.spyOn(Page, 'getHistoricalLinkRewrites')

    await movePage(page, 'foo', true)

    expect(rewriteSpy).not.toHaveBeenCalled()
    rewriteSpy.mockRestore()
    await expect(getPage('foo')).resolves.toEqual(expect.objectContaining({ id: page.id }))
    await expect(getRedirect('foo')).resolves.toBeUndefined()
    await expect(getRedirect('bar')).resolves.toEqual(expect.objectContaining({
      pageId: page.id,
      path: 'foo'
    }))
  })

  it('reuses another page historical path and preserves links to the original page', async () => {
    const pageA = await insertPage('foo', 'Page A')
    const pageB = await insertPage('something', 'Page B')
    const linkingPage = await insertPage('links', '[Page A](/foo)')
    await movePage(pageA, 'bar')
    await renderLink(linkingPage, '/foo')

    await movePage(pageB, 'foo', true)

    await expect(getRedirect('foo')).resolves.toBeUndefined()
    await expect(getPage('foo')).resolves.toEqual(expect.objectContaining({ id: pageB.id }))
    await expect(Page.query().findById(linkingPage.id)).resolves.toEqual(expect.objectContaining({
      content: '[Page A](/bar)'
    }))
    const rendered = await renderLink(await Page.query().findById(linkingPage.id), '/bar')
    expect(rendered).toContain('href="/bar"')
    await expect(PageLink.query().findOne({ pageId: linkingPage.id })).resolves.toEqual(expect.objectContaining({
      path: 'bar'
    }))
  })

  it.each([
    ['rendering', () => Page.renderPage.mockRejectedValueOnce(new Error('forced render failure'))],
    ['search indexing', () => global.WIKI.data.searchEngine.updated.mockRejectedValueOnce(new Error('forced search failure'))],
    ['storage sync', () => {
      global.WIKI.models.storage.pageEvent
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('forced storage failure'))
    }]
  ])('keeps committed path reuse and link rewrites when post-commit %s fails', async (operation, failOperation) => {
    const originalPage = await insertPage('foo', 'Original page')
    const replacementPage = await insertPage('replacement', 'Replacement page')
    const linkingPage = await insertPage('links', '[Original](/foo)')
    await movePage(originalPage, 'bar')
    await renderLink(linkingPage, '/foo')
    jest.clearAllMocks()
    failOperation()

    const result = await pageResolver.PageMutation.move(null, {
      id: replacementPage.id,
      destinationLocale: 'en',
      destinationPath: 'foo',
      reuseHistoricalPath: true
    }, context)

    expect(result.responseResult.succeeded).toBe(false)
    await expect(getPage('foo')).resolves.toEqual(expect.objectContaining({ id: replacementPage.id }))
    await expect(getPage('replacement')).resolves.toBeUndefined()
    await expect(getRedirect('foo')).resolves.toBeUndefined()
    await expect(getRedirect('replacement')).resolves.toEqual(expect.objectContaining({
      pageId: replacementPage.id,
      path: 'foo'
    }))
    await expect(Page.query().findById(linkingPage.id)).resolves.toEqual(expect.objectContaining({
      content: '[Original](/bar)'
    }))
  })

  it('keeps a historical redirect and link content when page creation fails', async () => {
    const originalPage = await insertPage('foo', 'Original page')
    const linkingPage = await insertPage('links', '[Original](/foo)')
    await movePage(originalPage, 'bar')
    await renderLink(linkingPage, '/foo')
    const historyCount = await PageHistory.query().resultSize()
    await fixture.knex.raw(`
      CREATE TRIGGER fail_reused_path_create
      BEFORE INSERT ON pages
      WHEN NEW.path = 'foo'
      BEGIN
        SELECT RAISE(FAIL, 'forced page creation failure');
      END
    `)

    try {
      await expect(Page.createPage({
        path: 'foo',
        locale: 'en',
        title: 'Replacement page',
        description: '',
        content: 'Replacement content',
        editor: 'markdown',
        isPrivate: false,
        isPublished: true,
        publishStartDate: '',
        publishEndDate: '',
        reuseHistoricalPath: true,
        skipStorage: true,
        tags: [],
        user
      })).rejects.toThrow('forced page creation failure')

      await expect(getPage('foo')).resolves.toBeUndefined()
      await expect(getRedirect('foo')).resolves.toEqual(expect.objectContaining({
        pageId: originalPage.id,
        path: 'bar'
      }))
      await expect(Page.query().findById(linkingPage.id)).resolves.toEqual(expect.objectContaining({
        content: '[Original](/foo)'
      }))
      await expect(PageHistory.query().resultSize()).resolves.toBe(historyCount)
    } finally {
      await fixture.knex.raw('DROP TRIGGER IF EXISTS fail_reused_path_create')
    }
  })

  it('rejects reuse atomically when a referring Markdown page cannot be edited', async () => {
    const original = await insertPage('old')
    const replacement = await insertPage('replacement')
    const referring = await insertPage('protected-links', '[Original](/old)')
    await movePage(original, 'current')
    await renderLink(referring, '/old')
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions, target) => target.path !== 'protected-links')
    try {
      const result = await pageResolver.PageMutation.move(null, {
        id: replacement.id, destinationLocale: 'en', destinationPath: 'old', reuseHistoricalPath: true
      }, context)
      expect(result.responseResult.succeeded).toBe(false)
      expect(result.responseResult.slug).toBe('PageUpdateForbidden')
      await expect(getPage('replacement')).resolves.toMatchObject({ id: replacement.id })
      await expect(getRedirect('old')).resolves.toMatchObject({ pageId: original.id })
      await expect(getPage('protected-links')).resolves.toMatchObject({ content: '[Original](/old)' })
    } finally {
      global.WIKI.auth.checkAccess.mockReturnValue(true)
    }
  })
})
