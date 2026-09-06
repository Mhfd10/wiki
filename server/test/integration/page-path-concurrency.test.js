/** @jest-environment node */

const pageFixture = require('./helpers/page-fixture')
const Page = require('../../models/pages')
const PageRedirect = require('../../models/pageRedirects')

describe('concurrent page path claims on separate database connections', () => {
  const fixture = pageFixture({ concurrent: true })
  const { user, insertPage } = fixture
  const createPage = () => Page.createPage({
    path: 'contested',
    locale: 'en',
    title: 'Created page',
    content: 'Content',
    description: '',
    editor: 'markdown',
    isPrivate: false,
    isPublished: true,
    tags: [],
    user,
    skipStorage: true
  })
  const movePage = page => Page.movePage({
    id: page.id,
    destinationPath: 'contested',
    destinationLocale: 'en',
    user,
    skipStorage: true
  })

  it('allows only one of two simultaneous creates without an artificial unique constraint', async () => {
    const results = await Promise.allSettled([createPage(), createPage()])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(Page.query().where({ path: 'contested', localeCode: 'en' })).resolves.toHaveLength(1)
  })

  it('allows only one of two simultaneous moves and preserves the losing source', async () => {
    const first = await insertPage('first')
    const second = await insertPage('second')
    const results = await Promise.allSettled([movePage(first), movePage(second)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(Page.query().where({ path: 'contested', localeCode: 'en' })).resolves.toHaveLength(1)
    const loser = results[0].status === 'rejected' ? first : second
    await expect(Page.query().findById(loser.id)).resolves.toMatchObject({ path: loser.path })
    await expect(PageRedirect.query().where('pageId', loser.id)).resolves.toHaveLength(0)
  })

  it('serializes a create competing with a move into the same unused URL', async () => {
    const page = await insertPage('source')
    const results = await Promise.allSettled([createPage(), movePage(page)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(Page.query().where({ path: 'contested', localeCode: 'en' })).resolves.toHaveLength(1)
  })
})
