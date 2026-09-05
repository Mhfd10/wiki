/**
 * Replace Markdown link destinations while leaving code samples untouched.
 *
 * @param {string} content Markdown content
 * @param {Function} replacer Receives a destination and returns its replacement
 * @returns {{content: string, replacements: number}} Rewritten content and count
 */
function rewriteLinkDestinations (content, replacer) {
  const blockCode = new Uint8Array(content.length)
  const html = new Uint8Array(content.length)
  const inlineCode = new Uint8Array(content.length)
  const references = new Uint8Array(content.length)
  const destinations = []
  const htmlDestinations = []

  const mark = (mask, start, end) => {
    for (let index = start; index < end; index++) {
      mask[index] = 1
    }
  }

  const isMarked = (mask, start, end = start + 1) => {
    for (let index = start; index < end; index++) {
      if (mask[index]) {
        return true
      }
    }
    return false
  }

  const isEscaped = index => {
    let slashes = 0
    for (let cursor = index - 1; cursor >= 0 && content.charAt(cursor) === '\\'; cursor--) {
      slashes++
    }
    return slashes % 2 === 1
  }

  const lineEndAt = start => {
    const newline = content.indexOf('\n', start)
    return newline < 0 ? content.length : newline
  }

  // Fenced and indented code blocks are never candidates for rewriting.
  let fence = null
  for (let lineStart = 0; lineStart < content.length;) {
    const lineEnd = lineEndAt(lineStart)
    const lineWithCR = content.slice(lineStart, lineEnd)
    const line = lineWithCR.endsWith('\r') ? lineWithCR.slice(0, -1) : lineWithCR
    const markedEnd = lineEnd < content.length ? lineEnd + 1 : lineEnd

    if (fence) {
      mark(blockCode, lineStart, markedEnd)
      const closingFence = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`)
      if (closingFence.test(line)) {
        fence = null
      }
    } else {
      const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (openingFence) {
        fence = {
          marker: openingFence[1].charAt(0),
          length: openingFence[1].length
        }
        mark(blockCode, lineStart, markedEnd)
      } else if (/^(?: {4}|\t)/.test(line)) {
        mark(blockCode, lineStart, markedEnd)
      }
    }
    lineStart = markedEnd
  }

  const findTagEnd = start => {
    let quote = null
    for (let cursor = start + 1; cursor < content.length; cursor++) {
      const character = content.charAt(cursor)
      if (quote) {
        if (character === quote) {
          quote = null
        }
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        return cursor + 1
      }
    }
    return -1
  }

  // Identify raw HTML, comments and autolinks before scanning Markdown syntax.
  // This prevents brackets or backticks in attributes from being interpreted as
  // Markdown while still allowing href destinations to be rewritten.
  for (let cursor = 0; cursor < content.length;) {
    if (content.charAt(cursor) !== '<' || blockCode[cursor]) {
      cursor++
      continue
    }

    if (content.startsWith('<!--', cursor)) {
      const commentEnd = content.indexOf('-->', cursor + 4)
      const end = commentEnd < 0 ? content.length : commentEnd + 3
      mark(html, cursor, end)
      cursor = end
      continue
    }

    const autolink = /^<((?:https?:\/\/|\/)[^<>\s]+)>/i.exec(content.slice(cursor))
    if (autolink) {
      const end = cursor + autolink[0].length
      mark(html, cursor, end)
      htmlDestinations.push({
        start: cursor + 1,
        end: end - 1
      })
      cursor = end
      continue
    }

    if (!/^<\/?[A-Za-z]/.test(content.slice(cursor))) {
      cursor++
      continue
    }
    const tagEnd = findTagEnd(cursor)
    if (tagEnd < 0) {
      cursor++
      continue
    }

    mark(html, cursor, tagEnd)
    if (content.charAt(cursor + 1) !== '/') {
      const tag = content.slice(cursor, tagEnd)
      const hrefPattern = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
      let href
      while ((href = hrefPattern.exec(tag)) !== null) {
        const value = href[1] !== undefined ? href[1] : (href[2] !== undefined ? href[2] : href[3])
        const equalsAt = href[0].indexOf('=')
        let valueAt = equalsAt + 1
        while (/\s/.test(href[0].charAt(valueAt))) {
          valueAt++
        }
        if (href[0].charAt(valueAt) === '"' || href[0].charAt(valueAt) === "'") {
          valueAt++
        }
        htmlDestinations.push({
          start: cursor + href.index + valueAt,
          end: cursor + href.index + valueAt + value.length
        })
      }
    }
    cursor = tagEnd
  }

  const backtickRunLength = start => {
    let end = start
    while (content.charAt(end) === '`') {
      end++
    }
    return end - start
  }

  // Code spans may contain line endings. A closing run must contain exactly
  // the same number of backticks as its opener.
  for (let cursor = 0; cursor < content.length;) {
    if (content.charAt(cursor) !== '`' || blockCode[cursor] || html[cursor] || isEscaped(cursor)) {
      cursor++
      continue
    }
    const markerLength = backtickRunLength(cursor)
    let closing = cursor + markerLength
    while (closing < content.length) {
      if (content.charAt(closing) !== '`' || blockCode[closing] || html[closing]) {
        closing++
        continue
      }
      const closingLength = backtickRunLength(closing)
      if (closingLength === markerLength) {
        break
      }
      closing += closingLength
    }
    if (closing < content.length) {
      const end = closing + markerLength
      mark(inlineCode, cursor, end)
      cursor = end
    } else {
      cursor += markerLength
    }
  }

  const isUnavailable = (start, end) => {
    return isMarked(blockCode, start, end) || isMarked(inlineCode, start, end)
  }

  const overlapsDestination = (start, end) => {
    return destinations.some(destination => start < destination.end && end > destination.start)
  }

  const addDestination = (start, end) => {
    if (start < end && !isUnavailable(start, end) && !overlapsDestination(start, end)) {
      destinations.push({ start, end })
    }
  }

  htmlDestinations.forEach(destination => addDestination(destination.start, destination.end))

  const skipWhitespace = (start, allowLineEndings) => {
    let cursor = start
    while (cursor < content.length) {
      const character = content.charAt(cursor)
      if (character === ' ' || character === '\t' || (allowLineEndings && (character === '\n' || character === '\r'))) {
        cursor++
      } else {
        break
      }
    }
    return cursor
  }

  const parseBareDestination = (start, stopAtOuterParen) => {
    let depth = 0
    let cursor = start
    while (cursor < content.length && !blockCode[cursor] && !inlineCode[cursor] && !html[cursor]) {
      const character = content.charAt(cursor)
      if (character === '\\' && cursor + 1 < content.length) {
        cursor += 2
        continue
      }
      if (/\s/.test(character)) {
        break
      }
      if (character === '(') {
        depth++
      } else if (character === ')') {
        if (depth === 0 && stopAtOuterParen) {
          break
        }
        if (depth === 0) {
          return null
        }
        depth--
      } else if (character === '<') {
        return null
      }
      cursor++
    }
    return depth === 0 ? { start, end: cursor } : null
  }

  const parseAngleDestination = start => {
    if (content.charAt(start) !== '<') {
      return null
    }
    for (let cursor = start + 1; cursor < content.length; cursor++) {
      const character = content.charAt(cursor)
      if (character === '\n' || character === '\r' || character === '<') {
        return null
      }
      if (character === '>' && !isEscaped(cursor)) {
        return { start, end: cursor + 1 }
      }
    }
    return null
  }

  const parseInlineLink = openingParen => {
    const destinationStart = skipWhitespace(openingParen + 1, true)
    const destination = content.charAt(destinationStart) === '<' ?
      parseAngleDestination(destinationStart) :
      parseBareDestination(destinationStart, true)
    if (!destination) {
      return null
    }

    let cursor = skipWhitespace(destination.end, true)
    if (content.charAt(cursor) === ')') {
      return { destination, end: cursor + 1 }
    }

    const titleMarker = content.charAt(cursor)
    if (titleMarker !== '"' && titleMarker !== "'" && titleMarker !== '(') {
      return null
    }
    const titleEndMarker = titleMarker === '(' ? ')' : titleMarker
    cursor++
    while (cursor < content.length) {
      if (content.charAt(cursor) === '\\' && cursor + 1 < content.length) {
        cursor += 2
      } else if (content.charAt(cursor) === titleEndMarker) {
        cursor++
        break
      } else {
        cursor++
      }
    }
    cursor = skipWhitespace(cursor, true)
    return content.charAt(cursor) === ')' ? { destination, end: cursor + 1 } : null
  }

  // Reference definitions can put their destination on the following line.
  for (let lineStart = 0; lineStart < content.length;) {
    const lineEnd = lineEndAt(lineStart)
    let cursor = lineStart
    let indentation = 0
    while (content.charAt(cursor) === ' ' && indentation < 4) {
      cursor++
      indentation++
    }
    if (indentation <= 3 && content.charAt(cursor) === '[' && !isUnavailable(cursor, cursor + 1)) {
      cursor++
      while (cursor < lineEnd && (content.charAt(cursor) !== ']' || isEscaped(cursor))) {
        cursor++
      }
      if (content.charAt(cursor) === ']' && content.charAt(cursor + 1) === ':') {
        let destinationStart = skipWhitespace(cursor + 2, false)
        let destinationLineEnd = lineEnd
        if (destinationStart === lineEnd - 1 && content.charAt(destinationStart) === '\r') {
          destinationStart = lineEnd
        }
        if (destinationStart === lineEnd && lineEnd < content.length) {
          destinationStart = lineEnd + 1
          let continuationIndent = 0
          while (content.charAt(destinationStart) === ' ' && continuationIndent < 4) {
            destinationStart++
            continuationIndent++
          }
          if (continuationIndent <= 3) {
            destinationLineEnd = lineEndAt(destinationStart)
          }
        }
        if (destinationStart <= destinationLineEnd) {
          const destination = content.charAt(destinationStart) === '<' ?
            parseAngleDestination(destinationStart) :
            parseBareDestination(destinationStart, false)
          if (destination && destination.end <= destinationLineEnd) {
            addDestination(destination.start, destination.end)
            const definitionEnd = destinationLineEnd < content.length ? destinationLineEnd + 1 : destinationLineEnd
            mark(references, lineStart, definitionEnd)
          }
        }
      }
    }
    lineStart = lineEnd < content.length ? lineEnd + 1 : lineEnd
  }

  const isMarkdownUnavailable = index => {
    return blockCode[index] || inlineCode[index] || html[index] || references[index]
  }

  // Inline links are parsed with balanced parentheses instead of a bounded
  // regular expression, so nested and escaped parentheses remain intact.
  const brackets = []
  for (let cursor = 0; cursor < content.length;) {
    if (isMarkdownUnavailable(cursor)) {
      cursor++
      continue
    }
    const character = content.charAt(cursor)
    if (character === '[' && !isEscaped(cursor)) {
      brackets.push(cursor)
    } else if (character === ']' && !isEscaped(cursor)) {
      const opener = brackets.pop()
      if (opener !== undefined && content.charAt(cursor + 1) === '(') {
        const link = parseInlineLink(cursor + 1)
        if (link) {
          addDestination(link.destination.start, link.destination.end)
          cursor = link.end
          continue
        }
      }
    }
    cursor++
  }

  // Plain absolute URLs are link destinations when Markdown linkification is
  // enabled. Punctuation at the end of a sentence is not part of the URL.
  const plainUrlPattern = /(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?])(?=$|[\s).,;:!?])/gi
  let plainUrl
  while ((plainUrl = plainUrlPattern.exec(content)) !== null) {
    const start = plainUrl.index + plainUrl[1].length
    const end = start + plainUrl[2].length
    if (!isMarkdownUnavailable(start)) {
      addDestination(start, end)
    }
  }

  destinations.sort((left, right) => left.start - right.start)
  let rewritten = ''
  let cursor = 0
  let replacements = 0
  destinations.forEach(destination => {
    if (destination.start < cursor) {
      return
    }
    const value = content.slice(destination.start, destination.end)
    const replacement = replacer(value)
    rewritten += content.slice(cursor, destination.start)
    if (replacement && replacement !== value) {
      rewritten += replacement
      replacements++
    } else {
      rewritten += value
    }
    cursor = destination.end
  })
  rewritten += content.slice(cursor)

  return {
    content: rewritten,
    replacements
  }
}

module.exports = {
  rewriteLinkDestinations
}
