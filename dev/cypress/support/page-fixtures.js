export const graph = (query, variables = {}) => cy.request({
  method: 'POST',
  url: '/graphql',
  body: { query, variables },
  log: false
}).then(({ body }) => {
  expect(body.errors, `GraphQL errors: ${JSON.stringify(body.errors || [])}`).to.equal(undefined)
  return body.data
})

export const login = () => graph(`mutation ($username: String!, $password: String!) {
  authentication { login(username: $username, password: $password, strategy: "local") {
    responseResult { succeeded message } jwt
  } }
}`, {
  username: Cypress.env('wikiUsername') || 'test@example.com',
  password: Cypress.env('wikiPassword') || '12345678'
}).then(({ authentication }) => {
  expect(authentication.login.responseResult.succeeded).to.equal(true)
  return cy.setCookie('jwt', authentication.login.jwt, { log: false })
})

export const createPage = path => graph(`mutation ($path: String!) {
  pages { create(path: $path, locale: "en", title: $path, content: "Original content",
    description: "", editor: "markdown", isPublished: true, isPrivate: false, tags: []) {
    responseResult { succeeded message } page { id }
  } }
}`, { path }).then(({ pages }) => {
  expect(pages.create.responseResult.succeeded, pages.create.responseResult.message).to.equal(true)
  return pages.create.page.id
})

export const movePage = (id, path) => graph(`mutation ($id: Int!, $path: String!) {
  pages { move(id: $id, destinationPath: $path, destinationLocale: "en") {
    responseResult { succeeded message }
  } }
}`, { id, path }).then(({ pages }) => {
  expect(pages.move.responseResult.succeeded, pages.move.responseResult.message).to.equal(true)
})

export const deletePage = id => graph(`mutation ($id: Int!) {
  pages { delete(id: $id) { responseResult { succeeded message } } }
}`, { id })
