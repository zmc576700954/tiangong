import { describe, it, expect } from 'vitest'
import { parseLinkTarget, splitWikiLinks, formatMetaValue, type WikiLinkResolution } from '../wiki-render'

const resolved = (targetTitle: string, displayText?: string): WikiLinkResolution => ({
  targetTitle, displayText, resolved: true, nodeId: 'node-x',
})

describe('splitWikiLinks', () => {
  it('按 wikilink 切分文本', () => {
    const segs = splitWikiLinks('前 [[页面A|别名]] 中 [[缺失]] 后', [resolved('页面A', '别名')])
    expect(segs).toEqual([
      { kind: 'text', text: '前 ' },
      { kind: 'link', raw: '[[页面A|别名]]', targetTitle: '页面A', displayText: '别名', resolved: true, nodeId: 'node-x' },
      { kind: 'text', text: ' 中 ' },
      { kind: 'link', raw: '[[缺失]]', targetTitle: '缺失', displayText: undefined, resolved: false, nodeId: undefined },
      { kind: 'text', text: ' 后' },
    ])
  })

  it('无链接时原样返回单段', () => {
    expect(splitWikiLinks('纯文本', [])).toEqual([{ kind: 'text', text: '纯文本' }])
  })
})

describe('parseLinkTarget', () => {
  it('解析别名语法', () => {
    expect(parseLinkTarget('页面A|别名')).toEqual({ targetTitle: '页面A', displayText: '别名' })
  })

  it('无别名时 displayText 为 undefined', () => {
    expect(parseLinkTarget('页面A')).toEqual({ targetTitle: '页面A', displayText: undefined })
  })

  it('目标取第一个竖线之前（额外竖线归入显示文本）', () => {
    expect(parseLinkTarget('页面A|别|名')).toEqual({ targetTitle: '页面A', displayText: '别|名' })
  })
})

describe('formatMetaValue', () => {
  it('字符串原样', () => expect(formatMetaValue('abc')).toBe('abc'))
  it('数组逗号连接', () => expect(formatMetaValue(['a', 'b'])).toBe('a, b'))
  it('对象 JSON', () => expect(formatMetaValue({ a: 1 })).toBe('{"a":1}'))
  it('布尔转字符串', () => expect(formatMetaValue(true)).toBe('true'))
})
