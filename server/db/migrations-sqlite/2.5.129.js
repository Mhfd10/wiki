exports.up = async knex => {
  await knex.schema.createTable('pageRedirects', table => {
    table.increments('id').primary()
    table.string('path').notNullable()
    table.string('localeCode', 5).notNullable()
    table.integer('pageId').unsigned().notNullable().references('id').inTable('pages').onDelete('CASCADE')
    table.string('createdAt').notNullable()
    table.unique(['path', 'localeCode'])
    table.index('pageId')
  })

  const [movedPaths, activePages] = await Promise.all([
    knex('pageHistory')
      .select('id', 'pageId', 'path', 'localeCode')
      .where('action', 'moved')
      .whereNotNull('pageId')
      .whereNotNull('localeCode')
      .orderBy('id', 'desc'),
    knex('pages').select('id', 'path', 'localeCode')
  ])
  const usedPaths = new Set(activePages.map(page => `${page.localeCode}\u0000${page.path}`))
  const activePageIds = new Set(activePages.map(page => page.id))
  const createdAt = new Date().toISOString()
  const redirects = movedPaths.reduce((entries, page) => {
    const key = `${page.localeCode}\u0000${page.path}`
    if (activePageIds.has(page.pageId) && !usedPaths.has(key)) {
      usedPaths.add(key)
      entries.push({
        path: page.path,
        localeCode: page.localeCode,
        pageId: page.pageId,
        createdAt
      })
    }
    return entries
  }, [])
  for (let idx = 0; idx < redirects.length; idx += 100) {
    await knex('pageRedirects').insert(redirects.slice(idx, idx + 100))
  }
}

exports.down = knex => {
  return knex.schema.dropTableIfExists('pageRedirects')
}
