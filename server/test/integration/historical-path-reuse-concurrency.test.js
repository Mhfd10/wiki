/** @jest-environment node */

const pageFixture = require('./helpers/page-fixture')
const Page = require('../../models/pages')
const PageHistory = require('../../models/pageHistory')

describe('concurrent historical path reuse', () => {
  const fixture = pageFixture({ concurrent: true })
  const { user, insertPage, movePage, renderLink, getRedirect } = fixture

  it('allows only one of two pages to consume a historical redirect', async () => {
    const original = await insertPage('old')
    await movePage(original, 'current')
    const contenders = await Promise.all([insertPage('first'), insertPage('second')])
    const results = await Promise.allSettled(contenders.map(page => Page.movePage({
      id: page.id,
      destinationPath: 'old',
      destinationLocale: 'en',
      reuseHistoricalPath: true,
      user,
      skipStorage: true
    })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(Page.query().where({ path: 'old', localeCode: 'en' })).resolves.toHaveLength(1)
    await expect(getRedirect('old')).resolves.toBeUndefined()
    const loser = contenders[results.findIndex(result => result.status === 'rejected')]
    await expect(Page.query().findById(loser.id)).resolves.toMatchObject({ path: loser.path })
  })

  it('recalculates a stale rewrite after an edit on another connection', async () => {
    const original = await insertPage('old')
    const referring = await insertPage('links', '[Original](/old)')
    await movePage(original, 'current')
    await renderLink(referring, '/old')
    const rewrites = await Page.getHistoricalLinkRewrites({ sourcePath: 'old', sourceLocale: 'en' })
    const connection = await fixture.knex.client.acquireConnection()
    try {
      await fixture.knex('pages').connection(connection).where('id', referring.id).update({
        content: 'Concurrent edit\n\n[Original](/old)',
        updatedAt: new Date().toISOString()
      })
      await fixture.knex.transaction(trx => Page.applyHistoricalLinkRewrites(rewrites, {
        user,
        authorId: user.id,
        trx
      }))
    } finally {
      await fixture.knex.client.releaseConnection(connection)
    }
    await expect(Page.query().findById(referring.id)).resolves.toMatchObject({
      content: 'Concurrent edit\n\n[Original](/current)'
    })
    await expect(PageHistory.query().findOne({ pageId: referring.id })).resolves.toMatchObject({
      content: 'Concurrent edit\n\n[Original](/old)'
    })
  })
})
