import { describe, it, expect } from 'vitest'
import {
  parseWikiMarkdown,
  extractWikiLinks,
  stringifyWikiMarkdown,
  normalizeWikiTitle,
} from '../markdown-utils'
import { BizGraphError, ErrorCode } from '../../errors'

describe('parseWikiMarkdown', () => {
  it('parses standard YAML frontmatter', () => {
    const markdown = `---
title: Hello Wiki
sources:
  - a.md
  - b.md
---

This is the body.`

    const result = parseWikiMarkdown(markdown)

    expect(result.raw).toBe(markdown)
    expect(result.frontmatter).toEqual({
      title: 'Hello Wiki',
      sources: ['a.md', 'b.md'],
    })
    expect(result.body).toBe('This is the body.')
    expect(result.title).toBe('Hello Wiki')
  })

  it('parses markdown without frontmatter', () => {
    const markdown = '# No Frontmatter\n\nJust body.'
    const result = parseWikiMarkdown(markdown)

    expect(result.raw).toBe(markdown)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe('# No Frontmatter\n\nJust body.')
    expect(result.title).toBe('No Frontmatter')
  })

  it('throws BizGraphError with WIKI_PARSE_ERROR on invalid frontmatter', () => {
    const markdown = `---
title: [unclosed
---

body`

    expect(() => parseWikiMarkdown(markdown)).toThrow(BizGraphError)
    expect(() => parseWikiMarkdown(markdown)).toThrow(/Failed to parse YAML frontmatter/)

    try {
      parseWikiMarkdown(markdown)
    } catch (err) {
      expect(err).toBeInstanceOf(BizGraphError)
      expect((err as BizGraphError).code).toBe(ErrorCode.WIKI_PARSE_ERROR)
    }
  })

  it('extracts title from H1 when frontmatter has no title', () => {
    const markdown = `---
author: me
---

# H1 Title\n\nBody.`

    const result = parseWikiMarkdown(markdown)
    expect(result.title).toBe('H1 Title')
  })

  it('extracts title from frontmatter even when H1 exists', () => {
    const markdown = `---
title: Frontmatter Title
---

# H1 Title\n\nBody.`

    const result = parseWikiMarkdown(markdown)
    expect(result.title).toBe('Frontmatter Title')
  })

  it('handles empty frontmatter', () => {
    const markdown = '---\n---\n\nBody.'
    const result = parseWikiMarkdown(markdown)

    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe('Body.')
  })

  it('trims leading and trailing blank lines from body', () => {
    const markdown = `---
title: Test
---



Body line 1


`

    const result = parseWikiMarkdown(markdown)
    expect(result.body).toBe('Body line 1')
  })

  it('supports Windows line endings', () => {
    const markdown = `---\r\ntitle: Win\r\n---\r\n\r\n# Heading\r\nBody.`
    const result = parseWikiMarkdown(markdown)

    expect(result.frontmatter).toEqual({ title: 'Win' })
    expect(result.body).toBe('# Heading\r\nBody.')
    expect(result.title).toBe('Win')
  })
})

describe('extractWikiLinks', () => {
  it('extracts simple wikilinks', () => {
    const markdown = 'See [[Node Title]] for details.'
    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'Node Title', position: 4 },
    ])
  })

  it('extracts wikilinks with display text', () => {
    const markdown = 'See [[Node Title|Display Text]] for details.'
    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'Node Title', displayText: 'Display Text', position: 4 },
    ])
  })

  it('extracts ID-style wikilinks', () => {
    const markdown = 'Ref [[node_abc123]].'
    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'node_abc123', position: 4 },
    ])
  })

  it('extracts multiple wikilinks with correct positions', () => {
    const markdown = '[[A]] then [[B|b]] and [[node_c]].'
    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'A', position: 0 },
      { targetTitle: 'B', displayText: 'b', position: 11 },
      { targetTitle: 'node_c', position: 23 },
    ])
  })

  it('does not extract links inside inline code', () => {
    const markdown = '`[[not a link]]` but [[real link]] works.'
    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'real link', position: 21 },
    ])
  })

  it('does not extract links inside fenced code blocks', () => {
    const markdown = `Some text.

\`\`\`
[[code block link]]
\`\`\`

[[outside link]]
`

    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'outside link', position: 41 },
    ])
  })

  it('does not extract links inside tilde code blocks', () => {
    const markdown = `~~~\n[[tilde block]]\n~~~\n\n[[valid]]`
    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'valid', position: 25 },
    ])
  })

  it('ignores unmatched brackets', () => {
    const markdown = '[[unclosed] and [not link] and ]][[valid]]'
    const links = extractWikiLinks(markdown)

    expect(links).toEqual([
      { targetTitle: 'valid', position: 33 },
    ])
  })
})

describe('stringifyWikiMarkdown', () => {
  it('serializes frontmatter and body with standard format', () => {
    const frontmatter = {
      title: 'Hello',
      sources: ['a.md', 'b.md'],
    }
    const body = 'Body content.'

    const result = stringifyWikiMarkdown(frontmatter, body)

    expect(result).toBe(`---
title: Hello
sources:
  - a.md
  - b.md
---

Body content.`)
  })

  it('returns body only when frontmatter is empty', () => {
    const body = 'Just body.'
    expect(stringifyWikiMarkdown({}, body)).toBe('Just body.')
    expect(stringifyWikiMarkdown({}, body)).toBe(body)
  })

  it('omits blank line when body is empty', () => {
    const result = stringifyWikiMarkdown({ title: 'Only Frontmatter' }, '')
    expect(result).toBe('---\ntitle: Only Frontmatter\n---')
  })

  it('strips leading blank lines from body', () => {
    const result = stringifyWikiMarkdown({ title: 'T' }, '\n\nBody.')
    expect(result).toBe('---\ntitle: T\n---\n\nBody.')
  })
})

describe('normalizeWikiTitle', () => {
  it('trims whitespace and collapses spaces', () => {
    expect(normalizeWikiTitle('  Hello   World  ')).toBe('Hello World')
  })

  it('replaces full-width spaces with half-width spaces', () => {
    expect(normalizeWikiTitle('Hello　World')).toBe('Hello World')
  })

  it('collapses mixed whitespace', () => {
    expect(normalizeWikiTitle('\tHello　　World\n')).toBe('Hello World')
  })
})
