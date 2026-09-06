const Model = require('objection').Model

/* global WIKI */

/**
 * Page Redirects model
 */
module.exports = class PageRedirect extends Model {
  static get tableName() { return 'pageRedirects' }

  static get jsonSchema () {
    return {
      type: 'object',
      required: ['path', 'localeCode', 'pageId'],

      properties: {
        id: {type: 'integer'},
        path: {type: 'string'},
        localeCode: {type: 'string'},
        pageId: {type: 'integer'},
        createdAt: {type: 'string'}
      }
    }
  }

  $beforeInsert() {
    this.createdAt = new Date().toISOString()
  }

  /**
   * Check whether a page can return to a historical path by consuming its
   * redirect. The destination must be unoccupied and the redirect must still
   * belong to the page being restored.
   *
   * @param {Object} opts Restore path properties
   * @returns {Promise<boolean>} Whether the historical path can be restored
   */
  static async canRestorePath ({ pageId, currentPath, currentLocale, path, locale }) {
    if (path === currentPath && locale === currentLocale) {
      return false
    }

    const [destinationPage, destinationRedirect] = await Promise.all([
      WIKI.models.pages.query().findOne({
        path,
        localeCode: locale
      }),
      this.resolve({ path, locale })
    ])

    return Boolean(!destinationPage && destinationRedirect && destinationRedirect.pageId === pageId)
  }

  /**
   * Build the common query used to resolve historical paths to current pages.
   *
   * @param {Object} [trx] Database transaction
   * @returns {Object} Redirect resolution query
   */
  static resolveQuery (trx) {
    return this.query(trx)
      .alias('redirect')
      .select({
        pageId: 'pages.id',
        path: 'pages.path',
        localeCode: 'pages.localeCode'
      })
      .join('pages', 'pages.id', 'redirect.pageId')
  }

  /**
   * Resolve a historical page path to the page's current path.
   *
   * @param {Object} opts Redirect source
   * @param {string} opts.path Page path
   * @param {string} opts.locale Page locale code
   * @param {Object} [opts.trx] Database transaction
   * @returns {Promise<Object|undefined>} Current page path, if the page still exists
   */
  static async resolve ({ path, locale, trx }) {
    return this.resolveQuery(trx)
      .where({
        'redirect.path': path,
        'redirect.localeCode': locale
      })
      .first()
  }

  /**
   * Resolve multiple historical page paths to their current pages in one query.
   *
   * @param {Object} opts Redirect sources
   * @param {Array<Object>} opts.refs Page paths with path and localeCode fields
   * @param {Object} [opts.trx] Database transaction
   * @returns {Promise<Array>} Resolved current page paths
   */
  static async resolveMany ({ refs = [], trx }) {
    if (refs.length < 1) {
      return []
    }

    return this.resolveQuery(trx)
      .select({
        sourcePath: 'redirect.path',
        sourceLocaleCode: 'redirect.localeCode'
      })
      .where(builder => {
        refs.forEach((ref, idx) => {
          const redirectRef = {
            'redirect.path': ref.path,
            'redirect.localeCode': ref.localeCode
          }
          if (idx < 1) {
            builder.where(redirectRef)
          } else {
            builder.orWhere(redirectRef)
          }
        })
      })
  }
}
