const { rewriteLinkDestinations } = require('../../helpers/markdown')

describe('helpers/markdown/rewriteLinkDestinations', () => {
  const replaceOldPath = destination => {
    return destination.replace('/en/old-page', '/en/moved-page')
  }

  it('rewrites inline and reference link destinations', () => {
    const input = [
      '[Inline](/en/old-page?view=full#details)',
      '[Wrapped](</en/old-page>)',
      '[Reference][page]',
      '[page]: /en/old-page "Page title"'
    ].join('\n')

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result.replacements).toBe(3)
    expect(result.content).toContain('[Inline](/en/moved-page?view=full#details)')
    expect(result.content).toContain('[Wrapped](</en/moved-page>)')
    expect(result.content).toContain('[page]: /en/moved-page "Page title"')
  })

  it('rewrites HTML links and autolinks', () => {
    const input = [
      '<a href="/en/old-page#details">Page</a>',
      '<https://wiki.example/en/old-page>',
      'See https://wiki.example/en/old-page for details.'
    ].join('\n')

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result.replacements).toBe(3)
    expect(result.content).toContain('href="/en/moved-page#details"')
    expect(result.content).toContain('<https://wiki.example/en/moved-page>')
    expect(result.content).toContain('See https://wiki.example/en/moved-page for details.')
  })

  it('does not rewrite links inside code', () => {
    const input = [
      '`[Inline code](/en/old-page)`',
      '```markdown',
      '[Fenced code](/en/old-page)',
      '```',
      '    [Indented code](/en/old-page)'
    ].join('\n')

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result.replacements).toBe(0)
    expect(result.content).toBe(input)
  })

  it('handles balanced parentheses, escapes and multiline destinations', () => {
    const input = [
      '[Nested](/en/old-page?return=(one(two))#details)',
      '[Escaped label \\]](/en/old-page)',
      '[Escaped destination](/en/old-page?value=one\\(two\\)#details)',
      '[Multiline inline](',
      '  /en/old-page?query=value#fragment',
      ')',
      '[Multiline reference][page]',
      '[page]:',
      '  /en/old-page#reference',
      '  "Reference title"'
    ].join('\n')

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result.replacements).toBe(5)
    expect(result.content).toBe(input.replace(/\/en\/old-page/g, '/en/moved-page'))
  })

  it('passes complete parenthesized paths to the replacer', () => {
    const replacer = jest.fn(destination => {
      return destination === '/page(foo(bar))' ? '/moved(foo(bar))' : destination
    })

    const result = rewriteLinkDestinations('[Nested](/page(foo(bar)))', replacer)

    expect(replacer).toHaveBeenCalledTimes(1)
    expect(replacer).toHaveBeenCalledWith('/page(foo(bar))')
    expect(result).toEqual({
      content: '[Nested](/moved(foo(bar)))',
      replacements: 1
    })
  })

  it('recognizes HTML href attributes with varied formatting', () => {
    const input = [
      '<a class="primary" rel="next" HREF = \'/en/old-page?query=value#fragment\' target="_blank">Page</a>',
      '<area shape="rect" href=/en/old-page>',
      '<a data-href="/en/old-page">Not an href</a>'
    ].join('\n')

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result.replacements).toBe(2)
    expect(result.content).toContain("HREF = '/en/moved-page?query=value#fragment'")
    expect(result.content).toContain('href=/en/moved-page')
    expect(result.content).toContain('data-href="/en/old-page"')
  })

  it('does not treat escaped link syntax or HTML comments as links', () => {
    const input = [
      '\\[Escaped link](/en/old-page)',
      '[Broken link](/en/old-page',
      'Stray syntax: ](/en/old-page)',
      'Plain path: /en/old-page',
      'Attribute-like text: href="/en/old-page"',
      '<!-- <a href="/en/old-page">Commented link</a> -->'
    ].join('\n')

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result.replacements).toBe(0)
    expect(result.content).toBe(input)
  })

  it('supports CRLF multiline reference definitions', () => {
    const input = '[Reference][page]\r\n[page]:\r\n  /en/old-page#fragment\r\n'

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result).toEqual({
      content: '[Reference][page]\r\n[page]:\r\n  /en/moved-page#fragment\r\n',
      replacements: 1
    })
  })

  it('handles code spans with unusual and multiline backtick runs', () => {
    const input = [
      '``A ` character and [link](/en/old-page)`` [Outside one](/en/old-page)',
      '`A multiline code span',
      '[link](/en/old-page)',
      'ends here`',
      '[Outside two](/en/old-page)'
    ].join('\n')

    const result = rewriteLinkDestinations(input, replaceOldPath)

    expect(result.replacements).toBe(2)
    expect(result.content).toBe([
      '``A ` character and [link](/en/old-page)`` [Outside one](/en/moved-page)',
      '`A multiline code span',
      '[link](/en/old-page)',
      'ends here`',
      '[Outside two](/en/moved-page)'
    ].join('\n'))
  })
})
