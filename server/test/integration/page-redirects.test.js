const pageFixture = require('./helpers/page-fixture')
const Page = require('../../models/pages')
const PageHistory = require('../../models/pageHistory')
const PageLink = require('../../models/pageLinks')
const PageRedirect = require('../../models/pageRedirects')
const pageResolver = require('../../graph/resolvers/page')

describe('page redirects', () => {
  const fixture = pageFixture()
  const { user, context, insertPage, movePage, getPage, getRedirect, renderLink, requestHistoricalPath } = fixture

  it('redirects the old path and loads the page after a basic move', async () => {
    const page = await insertPage('foo')

    await movePage(page, 'bar')

    const response = await requestHistoricalPath('foo')
    expect(response.redirect).toHaveBeenCalledWith(302, '/bar')
    expect(response.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    await expect(getPage('bar')).resolves.toEqual(expect.objectContaining({ id: page.id }))
  })

  it('rolls back a move and its history when redirect creation fails', async () => {
    const page = await insertPage('rollback-source')
    await fixture.knex.raw(`
      CREATE TRIGGER fail_move_redirect
      BEFORE INSERT ON pageRedirects
      WHEN NEW.path = 'rollback-source'
      BEGIN
        SELECT RAISE(FAIL, 'forced redirect failure');
      END
    `)

    try {
      const result = await pageResolver.PageMutation.move(null, {
        id: page.id,
        destinationLocale: 'en',
        destinationPath: 'rollback-destination'
      }, context)

      expect(result.responseResult.succeeded).toBe(false)
      await expect(getPage('rollback-source')).resolves.toEqual(expect.objectContaining({ id: page.id }))
      await expect(getPage('rollback-destination')).resolves.toBeUndefined()
      await expect(PageRedirect.query().where('pageId', page.id)).resolves.toHaveLength(0)
      await expect(PageHistory.query().where('pageId', page.id)).resolves.toHaveLength(0)
    } finally {
      await fixture.knex.raw('DROP TRIGGER IF EXISTS fail_move_redirect')
    }
  })

  it('resolves every historical path directly to the current page after multiple moves', async () => {
    const page = await insertPage('foo')
    const linkingPage = await insertPage('links')

    await movePage(page, 'bar')
    await movePage(page, 'baz')

    await expect(getRedirect('foo')).resolves.toEqual(expect.objectContaining({
      pageId: page.id,
      path: 'baz'
    }))
    await expect(getRedirect('bar')).resolves.toEqual(expect.objectContaining({
      pageId: page.id,
      path: 'baz'
    }))
    const redirects = await PageRedirect.resolveMany({
      refs: [
        { path: 'foo', localeCode: 'en' },
        { path: 'bar', localeCode: 'en' },
        { path: 'missing', localeCode: 'en' }
      ]
    })
    expect(redirects).toHaveLength(2)
    expect(redirects).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: 'foo', pageId: page.id, path: 'baz' }),
      expect.objectContaining({ sourcePath: 'bar', pageId: page.id, path: 'baz' })
    ]))
    const rendered = await renderLink(linkingPage, '/foo')
    expect(rendered).toContain('href="/baz"')
    await expect(PageLink.query().findOne({ pageId: linkingPage.id })).resolves.toEqual(expect.objectContaining({
      path: 'baz'
    }))
  })

  it('reports a historical-path collision when create has no explicit reuse consent', async () => {
    const originalPage = await insertPage('foo', 'Original page')
    await movePage(originalPage, 'bar')

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
      reuseHistoricalPath: false,
      skipStorage: true,
      tags: [],
      user
    })).rejects.toMatchObject({ name: 'PageHistoricalPathCollision' })

    await expect(getPage('foo')).resolves.toBeUndefined()
    await expect(getRedirect('foo')).resolves.toEqual(expect.objectContaining({
      pageId: originalPage.id,
      path: 'bar'
    }))
  })

  it('removes all historical redirects when the page is deleted', async () => {
    const page = await insertPage('foo')
    await movePage(page, 'bar')

    const result = await pageResolver.PageMutation.delete(null, { id: page.id }, context)

    expect(result.responseResult.succeeded).toBe(true)
    await expect(getPage('bar')).resolves.toBeUndefined()
    await expect(getRedirect('foo')).resolves.toBeUndefined()
    await expect(PageRedirect.query().where('pageId', page.id)).resolves.toHaveLength(0)
  })

  it('rolls back history and redirect removal when page deletion fails', async () => {
    const page = await insertPage('foo')
    await movePage(page, 'bar')
    const historyCount = await PageHistory.query().where('pageId', page.id).resultSize()
    await fixture.knex.raw(`
      CREATE TRIGGER fail_page_delete
      BEFORE DELETE ON pages
      WHEN OLD.path = 'bar'
      BEGIN
        SELECT RAISE(FAIL, 'forced page deletion failure');
      END
    `)

    try {
      const result = await pageResolver.PageMutation.delete(null, { id: page.id }, context)

      expect(result.responseResult.succeeded).toBe(false)
      await expect(getPage('bar')).resolves.toEqual(expect.objectContaining({ id: page.id }))
      await expect(getRedirect('foo')).resolves.toEqual(expect.objectContaining({
        pageId: page.id,
        path: 'bar'
      }))
      await expect(PageHistory.query().where('pageId', page.id).resultSize()).resolves.toBe(historyCount)
    } finally {
      await fixture.knex.raw('DROP TRIGGER IF EXISTS fail_page_delete')
    }
  })

  it('does not reveal a redirect destination without read access', async () => {
    const page = await insertPage('public-old')
    await movePage(page, 'restricted')
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions, target) => target.path !== 'restricted')
    try {
      const response = await requestHistoricalPath('public-old')
      expect(response.status).toHaveBeenCalledWith(403)
      expect(response.redirect).not.toHaveBeenCalled()
    } finally {
      global.WIKI.auth.checkAccess.mockReturnValue(true)
    }
  })

  it('preserves query parameters when redirecting across locales', async () => {
    const page = await insertPage('old')
    await fixture.knex('locales').insert({ code: 'fr' })
    await Page.movePage({ id: page.id, destinationPath: 'nouveau', destinationLocale: 'fr', user, skipStorage: true })
    global.WIKI.config.lang.namespacing = true
    try {
      const response = await requestHistoricalPath('en/old', { q: 'a b', page: '2' })
      expect(response.redirect).toHaveBeenCalledWith(302, '/fr/nouveau?q=a%20b&page=2')
    } finally {
      global.WIKI.config.lang.namespacing = false
    }
  })
})
