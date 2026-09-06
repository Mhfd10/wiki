import { login, createPage, movePage, deletePage, graph } from '../support/page-fixtures'

// Run explicitly against an initialized disposable wiki; setup-only CI remains unchanged.
const describeFeature = Cypress.env('pageRedirects') ? describe : describe.skip

describeFeature('Historical path confirmation dialogs', () => {
  let oldPath
  let currentPath
  let replacementPath
  const pageIds = []

  before(() => login())

  beforeEach(() => {
    Cypress.Cookies.preserveOnce('jwt')
    const prefix = `contribution-${Date.now()}`
    oldPath = `${prefix}-old`
    currentPath = `${prefix}-current`
    replacementPath = `${prefix}-replacement`
    createPage(oldPath).then(id => {
      pageIds.push(id)
      return movePage(id, currentPath)
    })
  })

  afterEach(() => {
    cy.window().then(win => { win.onbeforeunload = null })
    pageIds.splice(0).forEach(id => deletePage(id))
  })

  const fillEditor = () => {
    cy.contains('.body-2', 'Markdown').click()
    cy.contains('label', 'Title').next('input').clear().type('Replacement page')
    cy.contains('.dialog-header button', 'OK').click()
    cy.get('.CodeMirror').then(editor => editor[0].CodeMirror.setValue('Replacement content'))
  }

  const checkCreatedPage = path => {
    cy.location('pathname').should('include', path)
    graph(`query ($path: String!) {
      pages { singleByPath(path: $path, locale: "en") { id content } }
    }`, { path }).then(({ pages }) => {
      pageIds.push(pages.singleByPath.id)
      expect(pages.singleByPath.content).to.contain('Replacement content')
    })
  }

  it('lets the author keep the redirect when opening the old path in the editor', () => {
    cy.visit(`/e/en/${oldPath}`)
    cy.get('[data-testid="keep-redirect"]').should('be.visible')
    cy.screenshot('historical-path-create-confirmation')
    cy.get('[data-testid="keep-redirect"]').click()
    cy.location('pathname').should('include', currentPath)
  })

  it('creates a page at the historical URL after explicit confirmation', () => {
    cy.visit(`/e/en/${oldPath}`)
    cy.get('[data-testid="reuse-historical-path"]').should('be.visible').click()
    fillEditor()
    cy.get('[data-testid="save-page"]').click()
    checkCreatedPage(oldPath)
  })

  it('asks again when a confirmed editor changes to another historical destination', () => {
    createPage(replacementPath).then(id => {
      pageIds.push(id)
      return movePage(id, `${replacementPath}-current`)
    })
    cy.visit(`/e/en/${oldPath}`)
    cy.get('[data-testid="reuse-historical-path"]').click()
    fillEditor()
    cy.get('[data-testid="page-properties"]').click()
    cy.contains('label', 'Path').next('input').invoke('val', replacementPath).trigger('input')
    cy.contains('.dialog-header button', 'OK').click()
    cy.get('[data-testid="save-page"]').click()
    cy.get('[data-testid="reuse-historical-path"]').should('be.visible')
    cy.get('[data-testid="keep-redirect"]').click()
    cy.request({ url: `/${replacementPath}`, followRedirect: false }).its('status').should('eq', 302)
  })

  it('prompts when a path becomes reserved after the editor opens', () => {
    cy.visit(`/e/en/${replacementPath}`)
    fillEditor()
    createPage(replacementPath).then(id => {
      pageIds.push(id)
      return movePage(id, `${replacementPath}-current`)
    })
    cy.get('[data-testid="save-page"]').click()
    cy.get('[data-testid="reuse-historical-path"]').should('be.visible')
    cy.get('[data-testid="keep-redirect"]').click()
    cy.request({ url: `/${replacementPath}`, followRedirect: false }).its('status').should('eq', 302)
  })

  it('lets the author cancel and then confirm a move that replaces a redirect', () => {
    createPage(replacementPath).then(id => pageIds.push(id))
    const openMove = () => {
      cy.visit(`/en/${replacementPath}`)
      cy.get('[data-testid="page-actions"]').click()
      cy.get('[data-testid="move-page"]').click()
      cy.get('.page-selector input').last().clear().type(oldPath)
      cy.get('.page-selector button').last().click()
    }
    openMove()
    cy.get('[data-testid="keep-redirect"]').should('be.visible').click()
    cy.location('pathname').should('include', replacementPath)
    openMove()
    cy.get('[data-testid="replace-redirect-and-move"]').should('be.visible')
    cy.wait(500)
    cy.screenshot('historical-path-move-confirmation')
    cy.get('[data-testid="replace-redirect-and-move"]').click()
    cy.location('pathname').should('include', oldPath)
  })
})
