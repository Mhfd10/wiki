const Model = require('objection').Model
const _ = require('lodash')
const JSBinType = require('js-binary').Type
const pageHelper = require('../helpers/page')
const path = require('path')
const fs = require('fs-extra')
const yaml = require('js-yaml')
const striptags = require('striptags')
const emojiRegex = require('emoji-regex')
const he = require('he')
const CleanCSS = require('clean-css')
const TurndownService = require('turndown')
const turndownPluginGfm = require('@joplin/turndown-plugin-gfm').gfm
const cheerio = require('cheerio')
const markdownHelper = require('../helpers/markdown')
const URL = require('url').URL

/* global WIKI */

const frontmatterRegex = {
  html: /^(<!-{2}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{2}>)?(?:\n|\r)*([\w\W]*)*/,
  legacy: /^(<!-- TITLE: ?([\w\W]+?) ?-{2}>)?(?:\n|\r)?(<!-- SUBTITLE: ?([\w\W]+?) ?-{2}>)?(?:\n|\r)*([\w\W]*)*/i,
  markdown: /^(-{3}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{3})?(?:\n|\r)*([\w\W]*)*/
}

const punctuationRegex = /[!,:;/\\_+\-=()&#@<>$~%^*[\]{}"'|]+|(\.\s)|(\s\.)/ig
// const htmlEntitiesRegex = /(&#[0-9]{3};)|(&#x[a-zA-Z0-9]{2};)/ig

/**
 * Pages model
 */
module.exports = class Page extends Model {
  static get tableName() { return 'pages' }

  static get jsonSchema () {
    return {
      type: 'object',
      required: ['path', 'title'],

      properties: {
        id: {type: 'integer'},
        path: {type: 'string'},
        hash: {type: 'string'},
        title: {type: 'string'},
        description: {type: 'string'},
        isPublished: {type: 'boolean'},
        privateNS: {type: 'string'},
        publishStartDate: {type: 'string'},
        publishEndDate: {type: 'string'},
        content: {type: 'string'},
        contentType: {type: 'string'},

        createdAt: {type: 'string'},
        updatedAt: {type: 'string'}
      }
    }
  }

  static get jsonAttributes() {
    return ['extra']
  }

  static get relationMappings() {
    return {
      tags: {
        relation: Model.ManyToManyRelation,
        modelClass: require('./tags'),
        join: {
          from: 'pages.id',
          through: {
            from: 'pageTags.pageId',
            to: 'pageTags.tagId'
          },
          to: 'tags.id'
        }
      },
      links: {
        relation: Model.HasManyRelation,
        modelClass: require('./pageLinks'),
        join: {
          from: 'pages.id',
          to: 'pageLinks.pageId'
        }
      },
      author: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./users'),
        join: {
          from: 'pages.authorId',
          to: 'users.id'
        }
      },
      creator: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./users'),
        join: {
          from: 'pages.creatorId',
          to: 'users.id'
        }
      },
      editor: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./editors'),
        join: {
          from: 'pages.editorKey',
          to: 'editors.key'
        }
      },
      locale: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./locales'),
        join: {
          from: 'pages.localeCode',
          to: 'locales.code'
        }
      }
    }
  }

  $beforeUpdate() {
    this.updatedAt = new Date().toISOString()
  }
  $beforeInsert() {
    this.createdAt = new Date().toISOString()
    this.updatedAt = new Date().toISOString()
  }
  /**
   * Solving the violates foreign key constraint using cascade strategy
   * using static hooks
   * @see https://vincit.github.io/objection.js/api/types/#type-statichookarguments
   */
  static async beforeDelete({ asFindQuery, transaction }) {
    const pages = await asFindQuery().select('id')
    const pageIds = pages.map(page => page.id)
    if (pageIds.length > 0) {
      await WIKI.models.comments.query(transaction).delete().whereIn('pageId', pageIds)
    }
  }
  /**
   * Cache Schema
   */
  static get cacheSchema() {
    return new JSBinType({
      id: 'uint',
      authorId: 'uint',
      authorName: 'string',
      createdAt: 'string',
      creatorId: 'uint',
      creatorName: 'string',
      description: 'string',
      editorKey: 'string',
      isPrivate: 'boolean',
      isPublished: 'boolean',
      publishEndDate: 'string',
      publishStartDate: 'string',
      contentType: 'string',
      render: 'string',
      tags: [
        {
          tag: 'string',
          title: 'string'
        }
      ],
      extra: {
        js: 'string',
        css: 'string'
      },
      title: 'string',
      toc: 'string',
      updatedAt: 'string'
    })
  }

  /**
   * Inject page metadata into contents
   *
   * @returns {string} Page Contents with Injected Metadata
   */
  injectMetadata () {
    return pageHelper.injectPageMetadata(this)
  }

  /**
   * Get the page's file extension based on content type
   *
   * @returns {string} File Extension
   */
  getFileExtension() {
    return pageHelper.getFileExtension(this.contentType)
  }

  /**
   * Parse injected page metadata from raw content
   *
   * @param {String} raw Raw file contents
   * @param {String} contentType Content Type
   * @returns {Object} Parsed Page Metadata with Raw Content
   */
  static parseMetadata (raw, contentType) {
    let result
    try {
      switch (contentType) {
        case 'markdown':
          result = frontmatterRegex.markdown.exec(raw)
          if (result[2]) {
            return {
              ...yaml.safeLoad(result[2]),
              content: result[3]
            }
          } else {
            // Attempt legacy v1 format
            result = frontmatterRegex.legacy.exec(raw)
            if (result[2]) {
              return {
                title: result[2],
                description: result[4],
                content: result[5]
              }
            }
          }
          break
        case 'html':
          result = frontmatterRegex.html.exec(raw)
          if (result[2]) {
            return {
              ...yaml.safeLoad(result[2]),
              content: result[3]
            }
          }
          break
      }
    } catch (err) {
      WIKI.logger.warn('Failed to parse page metadata. Invalid syntax.')
    }
    return {
      content: raw
    }
  }

  /**
   * Create a New Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async createPage(opts) {
    // -> Validate path
    if (opts.path.includes('.') || opts.path.includes(' ') || opts.path.includes('\\') || opts.path.includes('//')) {
      throw new WIKI.Error.PageIllegalPath()
    }

    // -> Remove trailing slash
    if (opts.path.endsWith('/')) {
      opts.path = opts.path.slice(0, -1)
    }

    // -> Remove starting slash
    if (opts.path.startsWith('/')) {
      opts.path = opts.path.slice(1)
    }

    // -> Check for page access
    if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
      locale: opts.locale,
      path: opts.path
    })) {
      throw new WIKI.Error.PageDeleteForbidden()
    }

    const reuseHistoricalPath = opts.reuseHistoricalPath === true

    // -> Check for empty content
    if (!opts.content || _.trim(opts.content).length < 1) {
      throw new WIKI.Error.PageEmptyContent()
    }

    let historicalLinkRewrites = []

    // -> Format CSS Scripts
    let scriptCss = ''
    if (WIKI.auth.checkAccess(opts.user, ['write:styles'], {
      locale: opts.locale,
      path: opts.path
    })) {
      if (!_.isEmpty(opts.scriptCss)) {
        scriptCss = new CleanCSS({ inline: false }).minify(opts.scriptCss).styles
      } else {
        scriptCss = ''
      }
    }

    // -> Format JS Scripts
    let scriptJs = ''
    if (WIKI.auth.checkAccess(opts.user, ['write:scripts'], {
      locale: opts.locale,
      path: opts.path
    })) {
      scriptJs = opts.scriptJs || ''
    }

    // -> Create page and release the historical redirect, if explicitly confirmed
    const pageData = {
      authorId: opts.user.id,
      content: opts.content,
      creatorId: opts.user.id,
      contentType: _.get(_.find(WIKI.data.editors, ['key', opts.editor]), `contentType`, 'text'),
      description: opts.description,
      editorKey: opts.editor,
      hash: pageHelper.generateHash({ path: opts.path, locale: opts.locale, privateNS: opts.isPrivate ? 'TODO' : '' }),
      isPrivate: opts.isPrivate,
      isPublished: opts.isPublished,
      localeCode: opts.locale,
      path: opts.path,
      publishEndDate: opts.publishEndDate || '',
      publishStartDate: opts.publishStartDate || '',
      title: opts.title,
      toc: '[]',
      extra: JSON.stringify({
        js: scriptJs,
        css: scriptCss
      })
    }
    await WIKI.models.knex.transaction(async trx => {
      // -> Check for duplicate
      await WIKI.models.pages.lockDestinationLocale(opts.locale, trx)
      const duplicateQuery = WIKI.models.pages.query(trx)
        .select('id')
        .where('localeCode', opts.locale)
        .where('path', opts.path)
        .first()
      if (!String(_.get(WIKI, 'models.knex.client.config.client', '')).includes('sqlite')) {
        duplicateQuery.forUpdate()
      }
      const dupCheck = await duplicateQuery
      const redirectQuery = WIKI.models.pageRedirects.query(trx)
        .select('id', 'pageId')
        .where('localeCode', opts.locale)
        .where('path', opts.path)
        .first()
      if (!String(_.get(WIKI, 'models.knex.client.config.client', '')).includes('sqlite')) {
        redirectQuery.forUpdate()
      }
      const redirectCheck = await redirectQuery
      if (dupCheck) {
        throw new WIKI.Error.PageDuplicateCreate()
      }
      if (redirectCheck && !reuseHistoricalPath) {
        throw new WIKI.Error.PageHistoricalPathCollision()
      }

      historicalLinkRewrites = (redirectCheck && reuseHistoricalPath) ?
        await WIKI.models.pages.getHistoricalLinkRewrites({
          sourcePath: opts.path,
          sourceLocale: opts.locale,
          trx
        }) : []
      historicalLinkRewrites = await WIKI.models.pages.applyHistoricalLinkRewrites(historicalLinkRewrites, {
        authorId: opts.user.id,
        user: opts.user,
        trx
      })

      // -> Create page
      const insertedPage = await WIKI.models.pages.query(trx).insert(pageData)

      // -> Save Tags
      if (opts.tags && opts.tags.length > 0) {
        await WIKI.models.tags.associateTags({ tags: opts.tags, page: insertedPage, trx })
      }
      if (redirectCheck && reuseHistoricalPath) {
        const deletedRedirects = await WIKI.models.pageRedirects.query(trx).deleteById(redirectCheck.id)
        if (deletedRedirects !== 1) {
          throw new WIKI.Error.PageHistoricalPathCollision()
        }
      }
    })
    const page = await WIKI.models.pages.getPageFromDb({
      path: opts.path,
      locale: opts.locale,
      userId: opts.user.id,
      isPrivate: opts.isPrivate
    })

    // -> Render page to HTML
    await WIKI.models.pages.renderPage(page)

    // -> Rebuild page tree
    await WIKI.models.pages.rebuildTree()

    // -> Add to Search Index
    const pageContents = await WIKI.models.pages.query().findById(page.id).select('render')
    page.safeContent = WIKI.models.pages.cleanHTML(pageContents.render)
    await WIKI.data.searchEngine.created(page)

    // -> Add to Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'created',
        page
      })
    }

    // -> Reconnect Links
    await WIKI.models.pages.reconnectLinks({
      locale: page.localeCode,
      path: page.path,
      mode: 'create'
    })

    // -> Get latest updatedAt
    page.updatedAt = await WIKI.models.pages.query().findById(page.id).select('updatedAt').then(r => r.updatedAt)

    // -> Re-render and synchronize pages whose Markdown links were rewritten
    await WIKI.models.pages.syncHistoricalLinkRewrites(historicalLinkRewrites, {
      skipStorage: opts.skipStorage
    })

    return page
  }

  /**
   * Update an Existing Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async updatePage(opts) {
    // -> Fetch original page
    const ogPage = await WIKI.models.pages.query().findById(opts.id)
    if (!ogPage) {
      throw new Error('Invalid Page Id')
    }

    // -> Check for page access
    if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
      locale: ogPage.localeCode,
      path: ogPage.path
    })) {
      throw new WIKI.Error.PageUpdateForbidden()
    }

    // -> Check for empty content
    if (!opts.content || _.trim(opts.content).length < 1) {
      throw new WIKI.Error.PageEmptyContent()
    }

    // -> Format Extra Properties
    if (!_.isPlainObject(ogPage.extra)) {
      ogPage.extra = {}
    }

    // -> Format CSS Scripts
    let scriptCss = _.get(ogPage, 'extra.css', '')
    if (WIKI.auth.checkAccess(opts.user, ['write:styles'], {
      locale: opts.locale,
      path: opts.path
    })) {
      if (!_.isEmpty(opts.scriptCss)) {
        scriptCss = new CleanCSS({ inline: false }).minify(opts.scriptCss).styles
      } else {
        scriptCss = ''
      }
    }

    // -> Format JS Scripts
    let scriptJs = _.get(ogPage, 'extra.js', '')
    if (WIKI.auth.checkAccess(opts.user, ['write:scripts'], {
      locale: opts.locale,
      path: opts.path
    })) {
      scriptJs = opts.scriptJs || ''
    }

    const pagePatch = {
      authorId: opts.user.id,
      content: opts.content,
      description: opts.description,
      isPublished: opts.isPublished === true || opts.isPublished === 1,
      publishEndDate: opts.publishEndDate || '',
      publishStartDate: opts.publishStartDate || '',
      title: opts.title,
      extra: JSON.stringify({
        ...ogPage.extra,
        js: scriptJs,
        css: scriptCss
      })
    }

    let move = null
    await WIKI.models.knex.transaction(async trx => {
      const currentPageQuery = WIKI.models.pages.query(trx).findById(ogPage.id)
      if (!String(_.get(WIKI, 'models.knex.client.config.client', '')).includes('sqlite')) {
        currentPageQuery.forUpdate()
      }
      const currentPage = await currentPageQuery
      if (!currentPage) {
        throw new WIKI.Error.PageNotFound()
      }
      if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
        locale: currentPage.localeCode,
        path: currentPage.path
      })) {
        throw new WIKI.Error.PageUpdateForbidden()
      }

      // History, content, tag links and an optional move must commit together.
      // -> Create version snapshot
      await WIKI.models.pageHistory.addVersion({
        ...currentPage,
        isPublished: currentPage.isPublished === true || currentPage.isPublished === 1,
        action: opts.action ? opts.action : 'updated',
        versionDate: currentPage.updatedAt
      }, trx)

      // -> Update page
      await WIKI.models.pages.query(trx).patch(pagePatch).findById(currentPage.id)
      const updatedPage = await WIKI.models.pages.query(trx).findById(currentPage.id)

      // -> Save Tags
      await WIKI.models.tags.associateTags({ tags: opts.tags, page: updatedPage, trx })

      // -> Perform move?
      if ((opts.locale && opts.locale !== updatedPage.localeCode) || (opts.path && opts.path !== updatedPage.path)) {
        move = await WIKI.models.pages.movePageInTransaction({
          id: updatedPage.id,
          destinationLocale: opts.locale,
          destinationPath: opts.path,
          reclaimOwnHistoricalPath: opts.reclaimOwnHistoricalPath,
          reuseHistoricalPath: opts.reuseHistoricalPath,
          user: opts.user
        }, trx)
      } else {
        // -> Update title of page tree entry
        await trx.table('pageTree').where({
          pageId: updatedPage.id
        }).update('title', updatedPage.title)
      }
    })

    let page = await WIKI.models.pages.getPageFromDb(ogPage.id)

    // -> Render and synchronize only after the database transaction commits.
    await WIKI.models.pages.renderPage(page)
    if (move) {
      await WIKI.models.pages.syncPageMove(move, opts)
    } else {
      WIKI.events.outbound.emit('deletePageFromCache', page.hash)
    }

    // -> Update Search Index
    const pageContents = await WIKI.models.pages.query().findById(page.id).select('render')
    page.safeContent = WIKI.models.pages.cleanHTML(pageContents.render)
    await WIKI.data.searchEngine.updated(page)

    // -> Update on Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'updated',
        page
      })
    }

    // -> Get latest updatedAt
    page.updatedAt = await WIKI.models.pages.query().findById(page.id).select('updatedAt').then(r => r.updatedAt)

    return page
  }

  /**
   * Convert an Existing Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async convertPage(opts) {
    // -> Fetch original page
    const ogPage = await WIKI.models.pages.query().findById(opts.id)
    if (!ogPage) {
      throw new Error('Invalid Page Id')
    }

    if (ogPage.editorKey === opts.editor) {
      throw new Error('Page is already using this editor. Nothing to convert.')
    }

    // -> Check for page access
    if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
      locale: ogPage.localeCode,
      path: ogPage.path
    })) {
      throw new WIKI.Error.PageUpdateForbidden()
    }

    // -> Check content type
    const sourceContentType = ogPage.contentType
    const targetContentType = _.get(_.find(WIKI.data.editors, ['key', opts.editor]), `contentType`, 'text')
    const shouldConvert = sourceContentType !== targetContentType
    let convertedContent = null

    // -> Convert content
    if (shouldConvert) {
      // -> Markdown => HTML
      if (sourceContentType === 'markdown' && targetContentType === 'html') {
        if (!ogPage.render) {
          throw new Error('Aborted conversion because rendered page content is empty!')
        }
        convertedContent = ogPage.render

        const $ = cheerio.load(convertedContent, {
          decodeEntities: true
        })

        if ($.root().children().length > 0) {
          // Remove header anchors
          $('.toc-anchor').remove()

          // Attempt to convert tabsets
          $('tabset').each((tabI, tabElm) => {
            const tabHeaders = []
            // -> Extract templates
            $(tabElm).children('template').each((tmplI, tmplElm) => {
              if ($(tmplElm).attr('v-slot:tabs') === '') {
                $(tabElm).before('<ul class="tabset-headers">' + $(tmplElm).html() + '</ul>')
              } else {
                $(tabElm).after('<div class="markdown-tabset">' + $(tmplElm).html() + '</div>')
              }
            })
            // -> Parse tab headers
            $(tabElm).prev('.tabset-headers').children((i, elm) => {
              tabHeaders.push($(elm).html())
            })
            $(tabElm).prev('.tabset-headers').remove()
            // -> Inject tab headers
            $(tabElm).next('.markdown-tabset').children((i, elm) => {
              if (tabHeaders.length > i) {
                $(elm).prepend(`<h2>${tabHeaders[i]}</h2>`)
              }
            })
            $(tabElm).next('.markdown-tabset').prepend('<h1>Tabset</h1>')
            $(tabElm).remove()
          })

          convertedContent = $.html('body').replace('<body>', '').replace('</body>', '').replace(/&#x([0-9a-f]{1,6});/ig, (entity, code) => {
            code = parseInt(code, 16)

            // Don't unescape ASCII characters, assuming they're encoded for a good reason
            if (code < 0x80) return entity

            return String.fromCodePoint(code)
          })
        }

      // -> HTML => Markdown
      } else if (sourceContentType === 'html' && targetContentType === 'markdown') {
        const td = new TurndownService({
          bulletListMarker: '-',
          codeBlockStyle: 'fenced',
          emDelimiter: '*',
          fence: '```',
          headingStyle: 'atx',
          hr: '---',
          linkStyle: 'inlined',
          preformattedCode: true,
          strongDelimiter: '**'
        })

        td.use(turndownPluginGfm)

        td.keep(['kbd'])

        td.addRule('subscript', {
          filter: ['sub'],
          replacement: c => `~${c}~`
        })

        td.addRule('superscript', {
          filter: ['sup'],
          replacement: c => `^${c}^`
        })

        td.addRule('underline', {
          filter: ['u'],
          replacement: c => `_${c}_`
        })

        td.addRule('taskList', {
          filter: (n, o) => {
            return n.nodeName === 'INPUT' && n.getAttribute('type') === 'checkbox'
          },
          replacement: (c, n) => {
            return n.getAttribute('checked') ? '[x] ' : '[ ] '
          }
        })

        td.addRule('removeTocAnchors', {
          filter: (n, o) => {
            return n.nodeName === 'A' && n.classList.contains('toc-anchor')
          },
          replacement: c => ''
        })

        convertedContent = td.turndown(ogPage.content)
      // -> Unsupported
      } else {
        throw new Error('Unsupported source / destination content types combination.')
      }
    }

    await WIKI.models.knex.transaction(async trx => {
      // The conversion snapshot and converted page are one database change.
      if (shouldConvert) {
        await WIKI.models.pageHistory.addVersion({
          ...ogPage,
          isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
          action: 'updated',
          versionDate: ogPage.updatedAt
        }, trx)
      }

      await WIKI.models.pages.query(trx).patch({
        contentType: targetContentType,
        editorKey: opts.editor,
        ...(convertedContent ? { content: convertedContent } : {})
      }).where('id', ogPage.id)
    })
    const page = await WIKI.models.pages.getPageFromDb(ogPage.id)

    await WIKI.models.pages.deletePageFromCache(page.hash)
    WIKI.events.outbound.emit('deletePageFromCache', page.hash)

    // -> Update on Storage
    await WIKI.models.storage.pageEvent({
      event: 'updated',
      page
    })
  }

  /**
   * Serialize destination claims, including URLs with no page or redirect row.
   * Upstream pages have no unique path constraint. Lock an existing locale row
   * before checking its paths; SQLite acquires its writer lock via a no-op update.
   * Destination lookups must use current reads on repeatable-read databases.
   */
  static async lockDestinationLocale (locale, trx) {
    const query = trx('locales').where('code', locale)
    if (String(_.get(WIKI, 'models.knex.client.config.client', '')).includes('sqlite')) {
      await query.update({ code: locale })
    } else {
      await query.forUpdate()
    }
  }

  /**
   * Apply a page move using an existing transaction.
   *
   * `reuseHistoricalPath` is explicit caller consent to replace any historical
   * redirect. `reclaimOwnHistoricalPath` is reserved for version restoration
   * and only permits a redirect that still belongs to this page.
   *
   * @param {Object} opts Page properties
   * @param {Object} trx Database transaction
   * @returns {Promise<Object>} Details needed for post-commit synchronization
   */
  static async movePageInTransaction (opts, trx) {
    let pageQuery
    if (_.has(opts, 'id')) {
      pageQuery = WIKI.models.pages.query(trx).findById(opts.id)
    } else {
      pageQuery = WIKI.models.pages.query(trx).findOne({
        path: opts.path,
        localeCode: opts.locale
      })
    }
    if (!String(_.get(WIKI, 'models.knex.client.config.client', '')).includes('sqlite')) {
      pageQuery.forUpdate()
    }
    const page = await pageQuery
    if (!page) {
      throw new WIKI.Error.PageNotFound()
    }

    // -> Validate path
    let destinationPath = opts.destinationPath
    if (destinationPath.includes('.') || destinationPath.includes(' ') || destinationPath.includes('\\') || destinationPath.includes('//')) {
      throw new WIKI.Error.PageIllegalPath()
    }

    // -> Remove trailing slash
    if (destinationPath.endsWith('/')) {
      destinationPath = destinationPath.slice(0, -1)
    }

    // -> Remove starting slash
    if (destinationPath.startsWith('/')) {
      destinationPath = destinationPath.slice(1)
    }

    // -> Check for source page access
    if (!WIKI.auth.checkAccess(opts.user, ['manage:pages'], {
      locale: page.localeCode,
      path: page.path
    })) {
      throw new WIKI.Error.PageMoveForbidden()
    }
    // -> Check for destination page access
    if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
      locale: opts.destinationLocale,
      path: destinationPath
    })) {
      throw new WIKI.Error.PageMoveForbidden()
    }

    // -> Check for existing page at destination path
    await WIKI.models.pages.lockDestinationLocale(opts.destinationLocale, trx)
    const destinationQuery = WIKI.models.pages.query(trx).findOne({
      path: destinationPath,
      localeCode: opts.destinationLocale
    })
    if (!String(_.get(WIKI, 'models.knex.client.config.client', '')).includes('sqlite')) {
      destinationQuery.forUpdate()
    }
    const destPage = await destinationQuery
    const redirectQuery = WIKI.models.pageRedirects.query(trx).findOne({
      path: destinationPath,
      localeCode: opts.destinationLocale
    })
    if (!String(_.get(WIKI, 'models.knex.client.config.client', '')).includes('sqlite')) {
      redirectQuery.forUpdate()
    }
    const destRedirect = await redirectQuery
    const reuseHistoricalPath = opts.reuseHistoricalPath === true
    const reclaimOwnHistoricalPath = opts.reclaimOwnHistoricalPath === true
    if (destPage) {
      throw new WIKI.Error.PagePathCollision()
    }
    if (reclaimOwnHistoricalPath && (!destRedirect || destRedirect.pageId !== page.id)) {
      throw new WIKI.Error.PageHistoricalPathCollision()
    }
    if (destRedirect && !reuseHistoricalPath && !reclaimOwnHistoricalPath) {
      throw new WIKI.Error.PageHistoricalPathCollision()
    }

    let historicalLinkRewrites = (destRedirect && reuseHistoricalPath && destRedirect.pageId !== page.id) ?
      await WIKI.models.pages.getHistoricalLinkRewrites({
        sourcePath: destinationPath,
        sourceLocale: opts.destinationLocale,
        trx
      }) : []

    // -> Create version snapshot
    await WIKI.models.pageHistory.addVersion({
      ...page,
      action: 'moved',
      versionDate: page.updatedAt
    }, trx)

    const destinationHash = pageHelper.generateHash({ path: destinationPath, locale: opts.destinationLocale, privateNS: page.isPrivate ? 'TODO' : '' })

    // -> Move page
    const destinationTitle = (page.title === _.last(page.path.split('/')) ? _.last(destinationPath.split('/')) : page.title)
    historicalLinkRewrites = await WIKI.models.pages.applyHistoricalLinkRewrites(historicalLinkRewrites, {
      authorId: opts.user.id,
      user: opts.user,
      trx
    })
    if (destRedirect && (reuseHistoricalPath || reclaimOwnHistoricalPath)) {
      const deletedRedirects = await WIKI.models.pageRedirects.query(trx).deleteById(destRedirect.id)
      if (deletedRedirects !== 1) {
        throw new WIKI.Error.PageHistoricalPathCollision()
      }
    }
    const updatedPages = await WIKI.models.pages.query(trx).patch({
      path: destinationPath,
      localeCode: opts.destinationLocale,
      title: destinationTitle,
      hash: destinationHash
    }).findById(page.id)
    if (updatedPages !== 1) {
      throw new WIKI.Error.PageNotFound()
    }
    await WIKI.models.pageRedirects.query(trx).insert({
      path: page.path,
      localeCode: page.localeCode,
      pageId: page.id
    })

    return {
      page,
      destinationPath,
      destinationLocale: opts.destinationLocale,
      destinationTitle,
      destinationHash,
      historicalLinkRewrites
    }
  }

  /**
   * Synchronize non-transactional systems after a committed page move.
   *
   * @param {Object} move Committed move details
   * @param {Object} opts Page properties
   * @returns {Promise} Promise with no value
   */
  static async syncPageMove (move, opts) {
    const { page, destinationPath, destinationLocale, destinationTitle, destinationHash, historicalLinkRewrites } = move
    await WIKI.models.pages.deletePageFromCache(page.hash)
    WIKI.events.outbound.emit('deletePageFromCache', page.hash)

    // -> Rebuild page tree
    await WIKI.models.pages.rebuildTree()

    // -> Rename in Search Index
    const pageContents = await WIKI.models.pages.query().findById(page.id).select('render')
    page.safeContent = WIKI.models.pages.cleanHTML(pageContents.render)
    await WIKI.data.searchEngine.renamed({
      ...page,
      destinationPath,
      destinationLocaleCode: destinationLocale,
      title: destinationTitle,
      destinationHash
    })

    // -> Rename in Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'renamed',
        page: {
          ...page,
          destinationPath,
          destinationLocaleCode: destinationLocale,
          destinationHash,
          moveAuthorId: opts.user.id,
          moveAuthorName: opts.user.name,
          moveAuthorEmail: opts.user.email
        }
      })
    }

    // -> Reconnect Links : Changing old links to the new path
    await WIKI.models.pages.reconnectLinks({
      sourceLocale: page.localeCode,
      sourcePath: page.path,
      locale: destinationLocale,
      path: destinationPath,
      mode: 'move'
    })

    // -> Reconnect Links : Validate invalid links to the new path
    await WIKI.models.pages.reconnectLinks({
      locale: destinationLocale,
      path: destinationPath,
      mode: 'create'
    })

    // -> Re-render and synchronize pages whose Markdown links were rewritten
    await WIKI.models.pages.syncHistoricalLinkRewrites(historicalLinkRewrites, {
      skipStorage: opts.skipStorage
    })
  }

  /**
   * Move a Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise with no value
   */
  static async movePage(opts) {
    let move
    await WIKI.models.knex.transaction(async trx => {
      move = await WIKI.models.pages.movePageInTransaction(opts, trx)
    })
    await WIKI.models.pages.syncPageMove(move, opts)
  }

  /**
   * Delete an Existing Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise with no value
   */
  static async deletePage(opts) {
    const page = await WIKI.models.pages.getPageFromDb(_.has(opts, 'id') ? opts.id : opts)
    if (!page) {
      throw new WIKI.Error.PageNotFound()
    }

    // -> Check for page access
    if (!WIKI.auth.checkAccess(opts.user, ['delete:pages'], {
      locale: page.locale,
      path: page.path
    })) {
      throw new WIKI.Error.PageDeleteForbidden()
    }

    // -> Create version snapshot, remove redirects and delete page
    await WIKI.models.knex.transaction(async trx => {
      await WIKI.models.pageHistory.addVersion({
        ...page,
        action: 'deleted',
        versionDate: page.updatedAt
      }, trx)
      await WIKI.models.pageRedirects.query()
        .delete()
        .where('pageId', page.id)
        .transacting(trx)
      await WIKI.models.pages.query()
        .delete()
        .where('id', page.id)
        .transacting(trx)
    })
    await WIKI.models.pages.deletePageFromCache(page.hash)
    WIKI.events.outbound.emit('deletePageFromCache', page.hash)

    // -> Rebuild page tree
    await WIKI.models.pages.rebuildTree()

    // -> Delete from Search Index
    await WIKI.data.searchEngine.deleted(page)

    // -> Delete from Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'deleted',
        page
      })
    }

    // -> Reconnect Links
    await WIKI.models.pages.reconnectLinks({
      locale: page.localeCode,
      path: page.path,
      mode: 'delete'
    })
  }

  /**
   * Reconnect links to new/move/deleted page
   *
   * @param {Object} opts - Page parameters
   * @param {string} opts.path - Page Path
   * @param {string} opts.locale - Page Locale Code
   * @param {string} [opts.sourcePath] - Previous Page Path (move only)
   * @param {string} [opts.sourceLocale] - Previous Page Locale Code (move only)
   * @param {string} opts.mode - Page Update mode (create, move, delete)
   * @returns {Promise} Promise with no value
   */
  static async reconnectLinks (opts) {
    const pageHref = `/${opts.locale}/${opts.path}`
    const linkedPath = opts.mode === 'move' ? opts.sourcePath : opts.path
    const linkedLocale = opts.mode === 'move' ? opts.sourceLocale : opts.locale
    let replaceArgs = {
      from: '',
      to: ''
    }
    switch (opts.mode) {
      case 'create':
        replaceArgs.from = `<a href="${pageHref}" class="is-internal-link is-invalid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        break
      case 'move':
        const prevPageHref = `/${opts.sourceLocale}/${opts.sourcePath}`
        replaceArgs.from = `<a href="${prevPageHref}" class="is-internal-link is-valid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        break
      case 'delete':
        replaceArgs.from = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-invalid-page">`
        break
      default:
        return false
    }

    let affectedHashes = []
    // -> Perform replace and return affected page hashes (POSTGRES only)
    if (WIKI.config.db.type === 'postgres') {
      const qryHashes = await WIKI.models.pages.query()
        .returning('hash')
        .patch({
          render: WIKI.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to])
        })
        .whereIn('pages.id', function () {
          this.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': linkedPath,
            'pageLinks.localeCode': linkedLocale
          })
        })
      affectedHashes = qryHashes.map(h => h.hash)
    } else {
      // -> Perform replace, then query affected page hashes (MYSQL, MARIADB, MSSQL, SQLITE only)
      await WIKI.models.pages.query()
        .patch({
          render: WIKI.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to])
        })
        .whereIn('pages.id', function () {
          this.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': linkedPath,
            'pageLinks.localeCode': linkedLocale
          })
        })
      const qryHashes = await WIKI.models.pages.query()
        .column('hash')
        .whereIn('pages.id', function () {
          this.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': linkedPath,
            'pageLinks.localeCode': linkedLocale
          })
        })
      affectedHashes = qryHashes.map(h => h.hash)
    }
    if (opts.mode === 'move') {
      await WIKI.models.pageLinks.query()
        .patch({
          path: opts.path,
          localeCode: opts.locale
        })
        .where({
          path: opts.sourcePath,
          localeCode: opts.sourceLocale
        })
    }
    for (const hash of affectedHashes) {
      await WIKI.models.pages.deletePageFromCache(hash)
      WIKI.events.outbound.emit('deletePageFromCache', hash)
    }
  }

  /**
   * Find Markdown links that still use a historical path and rewrite them to
   * the moved page's current path.
   *
   * @param {Object} opts Historical redirect properties
   * @param {string} opts.sourcePath Historical page path
   * @param {string} opts.sourceLocale Historical page locale code
   * @param {Object} [opts.trx] Database transaction
   * @returns {Promise<Array>} Pages and rewritten content
   */
  static async getHistoricalLinkRewrites (opts) {
    const targetPage = await WIKI.models.pageRedirects.resolve({
      path: opts.sourcePath,
      locale: opts.sourceLocale,
      trx: opts.trx
    })
    if (!targetPage) {
      return []
    }

    const htmlCore = await WIKI.models.renderers.query(opts.trx).findById('htmlCore').select('config')
    // pageLinks stores the resolved destination, so use the redirect target to
    // narrow the source-level scan to pages that can contain the old URL.
    const markdownPages = await WIKI.models.pages.query(opts.trx)
      .where('contentType', 'markdown')
      .whereIn('pages.id', function () {
        this.select('pageLinks.pageId').from('pageLinks').where({
          'pageLinks.path': targetPage.path,
          'pageLinks.localeCode': targetPage.localeCode
        })
      })
    const rewriteOptions = {
      absoluteLinks: _.get(htmlCore, 'config.absoluteLinks', false),
      sourceLocale: opts.sourceLocale,
      sourcePath: opts.sourcePath,
      targetLocale: targetPage.localeCode,
      targetPath: targetPage.path
    }

    return markdownPages.reduce((rewrites, page) => {
      const rewrite = WIKI.models.pages.calculateHistoricalLinkRewrite(page, rewriteOptions)
      if (rewrite) {
        rewrites.push(rewrite)
      }
      return rewrites
    }, [])
  }

  /**
   * Calculate historical link replacements for one Markdown page.
   *
   * @param {Object} page Page to rewrite
   * @param {Object} opts Source and target link properties
   * @returns {Object|null} Rewritten page details, or null if unchanged
   */
  static calculateHistoricalLinkRewrite (page, opts) {
    const result = markdownHelper.rewriteLinkDestinations(page.content, destination => {
      const isWrapped = destination.startsWith('<') && destination.endsWith('>')
      let href = isWrapped ? destination.slice(1, -1) : destination
      const isFullWikiUrl = WIKI.config.host.length > 7 && href.indexOf(`${WIKI.config.host}/`) === 0
      if (isFullWikiUrl) {
        href = href.replace(WIKI.config.host, '')
      } else if (href.indexOf('://') >= 0 || href.startsWith('//')) {
        return destination
      }
      const hrefPath = href.split(/[?#]/, 1)[0]
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || hrefPath.indexOf('.') >= 0) {
        return destination
      }

      let normalizedHref = href
      if (WIKI.config.lang.namespacing) {
        if (!normalizedHref.startsWith('/')) {
          normalizedHref = opts.absoluteLinks ?
            `/${page.localeCode}/${normalizedHref}` :
            (page.path === 'home' ? `/${page.localeCode}/${normalizedHref}` : `/${page.localeCode}/${page.path}/${normalizedHref}`)
        } else {
          try {
            const absoluteUrl = new URL(`http://x${normalizedHref}`)
            if (!pageHelper.parsePath(absoluteUrl.pathname).explicitLocale) {
              normalizedHref = `/${page.localeCode}${normalizedHref}`
            }
          } catch (err) {
            return destination
          }
        }
      } else if (!normalizedHref.startsWith('/')) {
        normalizedHref = opts.absoluteLinks ?
          `/${normalizedHref}` :
          (page.path === 'home' ? `/${normalizedHref}` : `/${page.path}/${normalizedHref}`)
      }

      let parsedUrl
      try {
        parsedUrl = new URL(`http://x${normalizedHref}`)
      } catch (err) {
        return destination
      }
      const parsedPath = pageHelper.parsePath(parsedUrl.pathname)
      if (parsedPath.path !== opts.sourcePath || parsedPath.locale !== opts.sourceLocale) {
        return destination
      }

      const targetHref = WIKI.config.lang.namespacing ?
        `/${opts.targetLocale}/${opts.targetPath}` :
        `/${opts.targetPath}`
      const rewrittenHref = `${isFullWikiUrl ? WIKI.config.host : ''}${targetHref}${parsedUrl.search}${parsedUrl.hash}`
      return isWrapped ? `<${rewrittenHref}>` : rewrittenHref
    })
    return result.replacements > 0 ?
      {
        page,
        content: result.content,
        replacements: result.replacements,
        rewriteOptions: opts
      } :
      null
  }

  /**
   * Persist historical link rewrites as part of the operation that consumes
   * their redirect.
   *
   * @param {Array} rewrites Pages and rewritten content
   * @param {Object} opts Transaction and author properties
   * @returns {Promise<Array>} Rewrites that were actually applied
   */
  static async applyHistoricalLinkRewrites (rewrites, opts) {
    const appliedRewrites = []
    for (const rewrite of _.sortBy(rewrites, 'page.id')) {
      if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
        path: rewrite.page.path,
        locale: rewrite.page.localeCode
      })) {
        throw new WIKI.Error.PageUpdateForbidden()
      }
      const updatedRows = await WIKI.models.pages.query()
        .patch({
          authorId: opts.authorId,
          content: rewrite.content
        })
        .findById(rewrite.page.id)
        .where('updatedAt', rewrite.page.updatedAt)
        .where('content', rewrite.page.content)
        .where('contentType', rewrite.page.contentType)
        .where('localeCode', rewrite.page.localeCode)
        .where('path', rewrite.page.path)
        .transacting(opts.trx)

      if (updatedRows > 0) {
        await WIKI.models.pageHistory.addVersion({
          ...rewrite.page,
          action: 'updated',
          versionDate: rewrite.page.updatedAt
        }, opts.trx)
        appliedRewrites.push(rewrite)
        continue
      }

      // The page changed after it was initially read. Lock and rewrite the
      // latest version so stale Markdown can never overwrite a user's edit.
      const latestPageQuery = WIKI.models.pages.query()
        .findById(rewrite.page.id)
        .transacting(opts.trx)
      const dbClient = String(_.get(WIKI, 'models.knex.client.config.client', ''))
      if (!dbClient.includes('sqlite')) {
        latestPageQuery.forUpdate()
      }
      const latestPage = await latestPageQuery
      if (!latestPage || latestPage.contentType !== 'markdown') {
        continue
      }
      if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
        path: latestPage.path,
        locale: latestPage.localeCode
      })) {
        throw new WIKI.Error.PageUpdateForbidden()
      }
      const latestRewrite = WIKI.models.pages.calculateHistoricalLinkRewrite(latestPage, rewrite.rewriteOptions)
      if (!latestRewrite) {
        continue
      }

      await WIKI.models.pageHistory.addVersion({
        ...latestPage,
        action: 'updated',
        versionDate: latestPage.updatedAt
      }, opts.trx)
      await WIKI.models.pages.query()
        .patch({
          authorId: opts.authorId,
          content: latestRewrite.content
        })
        .findById(latestPage.id)
        .transacting(opts.trx)
      appliedRewrites.push(latestRewrite)
    }
    return appliedRewrites
  }

  /**
   * Re-render and synchronize pages changed by a historical link rewrite.
   *
   * @param {Array} rewrites Rewritten pages
   * @param {Object} opts Synchronization options
   * @returns {Promise} Promise with no value
   */
  static async syncHistoricalLinkRewrites (rewrites, opts = {}) {
    if (rewrites.length > 0) {
      const replacementCount = _.sumBy(rewrites, 'replacements')
      WIKI.logger.info(`Rewriting ${replacementCount} historical Markdown link(s) across ${rewrites.length} page(s)...`)
    }
    for (const rewrite of rewrites) {
      const page = await WIKI.models.pages.getPageFromDb(rewrite.page.id)
      await WIKI.models.pages.renderPage(page)
      WIKI.events.outbound.emit('deletePageFromCache', page.hash)

      const pageContents = await WIKI.models.pages.query().findById(page.id).select('render')
      page.safeContent = WIKI.models.pages.cleanHTML(pageContents.render)
      await WIKI.data.searchEngine.updated(page)

      if (!opts.skipStorage) {
        await WIKI.models.storage.pageEvent({
          event: 'updated',
          page
        })
      }
    }
  }

  /**
   * Rebuild page tree for new/updated/deleted page
   *
   * @returns {Promise} Promise with no value
   */
  static async rebuildTree() {
    const rebuildJob = await WIKI.scheduler.registerJob({
      name: 'rebuild-tree',
      immediate: true,
      worker: true
    })
    return rebuildJob.finished
  }

  /**
   * Trigger the rendering of a page
   *
   * @param {Object} page Page Model Instance
   * @returns {Promise} Promise with no value
   */
  static async renderPage(page) {
    const renderJob = await WIKI.scheduler.registerJob({
      name: 'render-page',
      immediate: true,
      worker: true
    }, page.id)
    return renderJob.finished
  }

  /**
   * Fetch an Existing Page from Cache if possible, from DB otherwise and save render to Cache
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async getPage(opts) {
    // -> Get from cache first
    let page = await WIKI.models.pages.getPageFromCache(opts)
    if (!page) {
      // -> Get from DB
      page = await WIKI.models.pages.getPageFromDb(opts)
      if (page) {
        if (page.render) {
          // -> Save render to cache
          await WIKI.models.pages.savePageToCache(page)
        } else {
          // -> No render? Last page render failed...
          throw new Error('Page has no rendered version. Looks like the Last page render failed. Try to edit the page and save it again.')
        }
      }
    }
    return page
  }

  /**
   * Fetch an Existing Page from the Database
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async getPageFromDb(opts) {
    const queryModeID = _.isNumber(opts)
    try {
      return WIKI.models.pages.query()
        .column([
          'pages.id',
          'pages.path',
          'pages.hash',
          'pages.title',
          'pages.description',
          'pages.isPrivate',
          'pages.isPublished',
          'pages.privateNS',
          'pages.publishStartDate',
          'pages.publishEndDate',
          'pages.content',
          'pages.render',
          'pages.toc',
          'pages.contentType',
          'pages.createdAt',
          'pages.updatedAt',
          'pages.editorKey',
          'pages.localeCode',
          'pages.authorId',
          'pages.creatorId',
          'pages.extra',
          {
            authorName: 'author.name',
            authorEmail: 'author.email',
            creatorName: 'creator.name',
            creatorEmail: 'creator.email'
          }
        ])
        .joinRelated('author')
        .joinRelated('creator')
        .withGraphJoined('tags')
        .modifyGraph('tags', builder => {
          builder.select('tag', 'title')
        })
        .where(queryModeID ? {
          'pages.id': opts
        } : {
          'pages.path': opts.path,
          'pages.localeCode': opts.locale
        })
        // .andWhere(builder => {
        //   if (queryModeID) return
        //   builder.where({
        //     'pages.isPublished': true
        //   }).orWhere({
        //     'pages.isPublished': false,
        //     'pages.authorId': opts.userId
        //   })
        // })
        // .andWhere(builder => {
        //   if (queryModeID) return
        //   if (opts.isPrivate) {
        //     builder.where({ 'pages.isPrivate': true, 'pages.privateNS': opts.privateNS })
        //   } else {
        //     builder.where({ 'pages.isPrivate': false })
        //   }
        // })
        .first()
    } catch (err) {
      WIKI.logger.warn(err)
      throw err
    }
  }

  /**
   * Save a Page Model Instance to Cache
   *
   * @param {Object} page Page Model Instance
   * @returns {Promise} Promise with no value
   */
  static async savePageToCache(page) {
    const cachePath = path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, `cache/${page.hash}.bin`)
    await fs.outputFile(cachePath, WIKI.models.pages.cacheSchema.encode({
      id: page.id,
      authorId: page.authorId,
      authorName: page.authorName,
      createdAt: page.createdAt,
      creatorId: page.creatorId,
      creatorName: page.creatorName,
      description: page.description,
      editorKey: page.editorKey,
      extra: {
        css: _.get(page, 'extra.css', ''),
        js: _.get(page, 'extra.js', '')
      },
      isPrivate: page.isPrivate === 1 || page.isPrivate === true,
      isPublished: page.isPublished === 1 || page.isPublished === true,
      publishEndDate: page.publishEndDate,
      publishStartDate: page.publishStartDate,
      contentType: page.contentType,
      render: page.render,
      tags: page.tags.map(t => _.pick(t, ['tag', 'title'])),
      title: page.title,
      toc: _.isString(page.toc) ? page.toc : JSON.stringify(page.toc),
      updatedAt: page.updatedAt
    }))
  }

  /**
   * Fetch an Existing Page from Cache
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async getPageFromCache(opts) {
    const pageHash = pageHelper.generateHash({ path: opts.path, locale: opts.locale, privateNS: opts.isPrivate ? 'TODO' : '' })
    const cachePath = path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, `cache/${pageHash}.bin`)

    try {
      const pageBuffer = await fs.readFile(cachePath)
      let page = WIKI.models.pages.cacheSchema.decode(pageBuffer)
      return {
        ...page,
        path: opts.path,
        localeCode: opts.locale,
        isPrivate: opts.isPrivate
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return false
      }
      WIKI.logger.error(err)
      throw err
    }
  }

  /**
   * Delete an Existing Page from Cache
   *
   * @param {String} page Page Unique Hash
   * @returns {Promise} Promise with no value
   */
  static async deletePageFromCache(hash) {
    return fs.remove(path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, `cache/${hash}.bin`))
  }

  /**
   * Flush the contents of the Cache
   */
  static async flushCache() {
    return fs.emptyDir(path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, `cache`))
  }

  /**
   * Migrate all pages from a source locale to the target locale
   *
   * @param {Object} opts Migration properties
   * @param {string} opts.sourceLocale Source Locale Code
   * @param {string} opts.targetLocale Target Locale Code
   * @returns {Promise} Promise with no value
   */
  static async migrateToLocale({ sourceLocale, targetLocale }) {
    return WIKI.models.pages.query()
      .patch({
        localeCode: targetLocale
      })
      .where({
        localeCode: sourceLocale
      })
      .whereNotExists(function() {
        this.select('id').from('pages AS pagesm').where('pagesm.localeCode', targetLocale).andWhereRaw('pagesm.path = pages.path')
      })
  }

  /**
   * Clean raw HTML from content for use in search engines
   *
   * @param {string} rawHTML Raw HTML
   * @returns {string} Cleaned Content Text
   */
  static cleanHTML(rawHTML = '') {
    let data = striptags(rawHTML || '', [], ' ')
      .replace(emojiRegex(), '')
      // .replace(htmlEntitiesRegex, '')
    return he.decode(data)
      .replace(punctuationRegex, ' ')
      .replace(/(\r\n|\n|\r)/gm, ' ')
      .replace(/\s\s+/g, ' ')
      .split(' ').filter(w => w.length > 1).join(' ').toLowerCase()
  }

  /**
   * Subscribe to HA propagation events
   */
  static subscribeToEvents() {
    WIKI.events.inbound.on('deletePageFromCache', hash => {
      WIKI.models.pages.deletePageFromCache(hash)
    })
    WIKI.events.inbound.on('flushCache', () => {
      WIKI.models.pages.flushCache()
    })
  }
}
