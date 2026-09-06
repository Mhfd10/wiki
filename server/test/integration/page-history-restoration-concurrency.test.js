/** @jest-environment node */

const pageFixture = require('./helpers/page-fixture')
const Page = require('../../models/pages')
const PageHistory = require('../../models/pageHistory')

describe('concurrent historical path restoration', () => {
  const fixture = pageFixture({ concurrent: true })
  const { user, insertPage, movePage, getPage } = fixture

  it('allows only one operation to claim a historical destination', async () => {
    const owner = await insertPage('old')
    const contender = await insertPage('contender')
    await movePage(owner, 'current')
    const version = await PageHistory.query().findOne({ pageId: owner.id, path: 'old', action: 'moved' })

    const restore = Page.updatePage({
      ...await global.WIKI.models.pageHistory.getVersion({ pageId: owner.id, versionId: version.id }),
      id: owner.id,
      path: 'old',
      locale: 'en',
      reclaimOwnHistoricalPath: true,
      skipStorage: true,
      user,
      action: 'restored'
    })
    const reuse = Page.movePage({
      id: contender.id,
      destinationPath: 'old',
      destinationLocale: 'en',
      reuseHistoricalPath: true,
      skipStorage: true,
      user
    })

    const results = await Promise.allSettled([restore, reuse])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(Page.query().where({ path: 'old', localeCode: 'en' })).resolves.toHaveLength(1)
    const restoredPage = await getPage('old')
    expect([owner.id, contender.id]).toContain(restoredPage.id)
    const losingId = restoredPage.id === owner.id ? contender.id : owner.id
    await expect(Page.query().findById(losingId)).resolves.toBeDefined()
  })
})
