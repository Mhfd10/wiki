const pageFixture = require('./helpers/page-fixture')
const Page = require('../../models/pages')
const PageHistory = require('../../models/pageHistory')
const Tag = require('../../models/tags')
const pageResolver = require('../../graph/resolvers/page')

describe('page mutation transactions', () => {
  const fixture = pageFixture()
  const create = (path, tags = []) => Page.createPage({
    path,
    locale: 'en',
    title: path,
    description: '',
    content: 'Content',
    editor: 'markdown',
    isPrivate: false,
    isPublished: true,
    tags,
    skipStorage: true,
    user: fixture.user
  })

  it('rolls back page creation when associating tags fails', async () => {
    const spy = jest.spyOn(Tag, 'associateTags').mockRejectedValueOnce(new Error('tag failure'))
    try {
      await expect(create('failed-create', ['tag'])).rejects.toThrow('tag failure')
      await expect(fixture.getPage('failed-create')).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('rolls back content, tags and history when an update cannot move to its destination', async () => {
    const page = await fixture.insertPage('source', 'Before')
    await fixture.insertPage('occupied')
    await expect(Page.updatePage({
      id: page.id,
      path: 'occupied',
      locale: 'en',
      title: page.title,
      description: '',
      content: 'After',
      isPublished: true,
      tags: ['new-tag'],
      skipStorage: true,
      user: fixture.user
    })).rejects.toMatchObject({ name: 'PagePathCollision' })
    await expect(fixture.getPage('source')).resolves.toMatchObject({ content: 'Before' })
    await expect(PageHistory.query().where('pageId', page.id)).resolves.toHaveLength(0)
    await expect(Tag.query()).resolves.toHaveLength(0)
  })

  it('rolls back a move snapshot when the page update fails', async () => {
    const page = await fixture.insertPage('source')
    await fixture.knex.raw("CREATE TRIGGER fail_move BEFORE UPDATE ON pages BEGIN SELECT RAISE(FAIL, 'move failure'); END")
    try {
      await expect(Page.movePage({
        id: page.id,
        destinationPath: 'destination',
        destinationLocale: 'en',
        user: fixture.user,
        skipStorage: true
      })).rejects.toThrow('move failure')
      await expect(fixture.getPage('source')).resolves.toMatchObject({ id: page.id })
      await expect(PageHistory.query().where('pageId', page.id)).resolves.toHaveLength(0)
    } finally {
      await fixture.knex.raw('DROP TRIGGER fail_move')
    }
  })

  it('rolls back deletion history when deleting the page fails', async () => {
    const page = await fixture.insertPage('source')
    await fixture.knex.raw("CREATE TRIGGER fail_delete BEFORE DELETE ON pages BEGIN SELECT RAISE(FAIL, 'delete failure'); END")
    try {
      await expect(Page.deletePage({ id: page.id, user: fixture.user, skipStorage: true })).rejects.toThrow('delete failure')
      await expect(fixture.getPage('source')).resolves.toMatchObject({ id: page.id })
      await expect(PageHistory.query().where('pageId', page.id)).resolves.toHaveLength(0)
    } finally {
      await fixture.knex.raw('DROP TRIGGER fail_delete')
    }
  })

  it('keeps tag associations when deleting a tag fails', async () => {
    const page = await create('tagged', ['tag'])
    const tag = await Tag.query().findOne({ tag: 'tag' })
    await fixture.knex.raw("CREATE TRIGGER fail_tag_delete BEFORE DELETE ON tags BEGIN SELECT RAISE(FAIL, 'tag failure'); END")
    try {
      const result = await pageResolver.PageMutation.deleteTag(null, { id: tag.id }, fixture.context)
      expect(result.responseResult.succeeded).toBe(false)
      await expect(fixture.knex('pageTags').where({ pageId: page.id, tagId: tag.id })).resolves.toHaveLength(1)
    } finally {
      await fixture.knex.raw('DROP TRIGGER fail_tag_delete')
    }
  })

  it('rolls back the conversion snapshot when saving converted content fails', async () => {
    const page = await fixture.insertPage('convert-source')
    await Page.query().patch({ render: '<p>Content</p>' }).findById(page.id)
    global.WIKI.data.editors.push({ key: 'ckeditor', contentType: 'html' })
    await fixture.knex.raw("CREATE TRIGGER fail_convert BEFORE UPDATE ON pages BEGIN SELECT RAISE(FAIL, 'conversion failure'); END")
    try {
      await expect(Page.convertPage({ id: page.id, editor: 'ckeditor', user: fixture.user })).rejects.toThrow('conversion failure')
      await expect(fixture.getPage('convert-source')).resolves.toMatchObject({ contentType: 'markdown' })
      await expect(PageHistory.query().where('pageId', page.id)).resolves.toHaveLength(0)
    } finally {
      await fixture.knex.raw('DROP TRIGGER fail_convert')
      global.WIKI.data.editors.pop()
    }
  })

  it('cleans comments for every deleted page and accepts an empty deletion', async () => {
    const first = await fixture.insertPage('first')
    const second = await fixture.insertPage('second')
    await fixture.knex('comments').insert([{ pageId: first.id }, { pageId: second.id }])
    await fixture.knex.transaction(async trx => {
      await Page.query(trx).delete().whereIn('id', [first.id, second.id])
      await Page.query(trx).delete().where('id', first.id)
    })
    await expect(fixture.knex('comments')).resolves.toHaveLength(0)
  })
})
