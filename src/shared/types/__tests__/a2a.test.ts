/**
 * A2A wire types — unit tests
 *
 * Phase D9 C1. Covers:
 * - isA2AMessage / isA2APart / isA2AAgentCard type guards
 * - toAgentSessionConfig / fromAgentSessionConfig bidirectional mapping
 * - SUBAGENT_AGENT_TYPE_PATTERN regex covering recipe: / a2a: / plain
 */

import { describe, it, expect } from 'vitest'
import {
  isA2AMessage,
  isA2APart,
  isA2AAgentCard,
  toAgentSessionConfig,
  fromAgentSessionConfig,
  SUBAGENT_AGENT_TYPE_PATTERN,
  A2A_PROTOCOL_VERSION,
  A2A_DEFAULT_PORT,
  A2A_DEFAULT_BIND_ADDRESS,
  A2A_MIN_API_KEY_LENGTH,
  type A2ATextPart,
  type A2AFilePart,
  type A2ADataPart,
  type A2AMessage,
  type A2AAgentCard,
} from '@shared/types/a2a'

describe('A2A type guards', () => {
  describe('isA2APart', () => {
    it('accepts valid TextPart', () => {
      const part: A2ATextPart = { type: 'text', text: 'hello' }
      expect(isA2APart(part)).toBe(true)
    })

    it('accepts valid FilePart with bytes', () => {
      const part: A2AFilePart = {
        type: 'file',
        name: 'spec.md',
        mimeType: 'text/markdown',
        bytes: Buffer.from('hi').toString('base64'),
      }
      expect(isA2APart(part)).toBe(true)
    })

    it('accepts valid DataPart with structured object', () => {
      const part: A2ADataPart = {
        type: 'data',
        data: { foo: 1, bar: ['a', 'b'] },
      }
      expect(isA2APart(part)).toBe(true)
    })

    it('rejects null and primitives', () => {
      expect(isA2APart(null)).toBe(false)
      expect(isA2APart(undefined)).toBe(false)
      expect(isA2APart('text')).toBe(false)
      expect(isA2APart(42)).toBe(false)
      expect(isA2APart([])).toBe(false)
    })

    it('rejects unknown type discriminant', () => {
      expect(isA2APart({ type: 'video', url: 'x' })).toBe(false)
    })

    it('rejects TextPart missing text field', () => {
      expect(isA2APart({ type: 'text' })).toBe(false)
      expect(isA2APart({ type: 'text', text: 42 })).toBe(false)
    })

    it('rejects FilePart missing mimeType', () => {
      expect(isA2APart({ type: 'file', name: 'a' })).toBe(false)
    })

    it('rejects DataPart missing data field', () => {
      expect(isA2APart({ type: 'data' })).toBe(false)
      expect(isA2APart({ type: 'data', data: 'not-object' })).toBe(false)
    })
  })

  describe('isA2AMessage', () => {
    it('accepts user message with text part', () => {
      const msg: A2AMessage = {
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      }
      expect(isA2AMessage(msg)).toBe(true)
    })

    it('accepts agent message with contextId and taskId', () => {
      const msg: A2AMessage = {
        role: 'agent',
        parts: [{ type: 'text', text: 'reply' }],
        contextId: 'ctx-1',
        taskId: 'task-1',
      }
      expect(isA2AMessage(msg)).toBe(true)
    })

    it('rejects invalid role', () => {
      expect(
        isA2AMessage({ role: 'system', parts: [{ type: 'text', text: 'x' }] }),
      ).toBe(false)
    })

    it('rejects non-array parts', () => {
      expect(isA2AMessage({ role: 'user', parts: 'oops' })).toBe(false)
    })

    it('rejects message with any invalid part', () => {
      expect(
        isA2AMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'ok' }, { type: 'video', url: 'x' }],
        }),
      ).toBe(false)
    })
  })

  describe('isA2AAgentCard', () => {
    const validCard: A2AAgentCard = {
      a2aVersion: A2A_PROTOCOL_VERSION,
      name: 'bizgraph',
      description: 'BizGraph agent',
      url: 'http://127.0.0.1:8089',
      capabilities: ['streaming'],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    }

    it('accepts a minimal valid card', () => {
      expect(isA2AAgentCard(validCard)).toBe(true)
    })

    it('rejects card missing name', () => {
      expect(isA2AAgentCard({ ...validCard, name: undefined })).toBe(false)
    })

    it('rejects card missing url', () => {
      expect(isA2AAgentCard({ ...validCard, url: undefined })).toBe(false)
    })

    it('rejects card missing a2aVersion', () => {
      expect(isA2AAgentCard({ ...validCard, a2aVersion: undefined })).toBe(false)
    })

    it('rejects card with non-array capabilities', () => {
      expect(
        isA2AAgentCard({ ...validCard, capabilities: 'streaming' }),
      ).toBe(false)
    })

    it('rejects card with non-array skills', () => {
      expect(isA2AAgentCard({ ...validCard, skills: 'oops' })).toBe(false)
    })
  })
})

describe('AgentSessionConfig ↔ AgentCard mapping', () => {
  describe('toAgentSessionConfig', () => {
    it('extracts text from first TextPart as prompt', () => {
      const card: A2AAgentCard = {
        a2aVersion: A2A_PROTOCOL_VERSION,
        name: 'remote',
        description: 'Remote agent',
        url: 'https://remote.example.com',
        capabilities: [],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }
      const msg: A2AMessage = {
        role: 'user',
        parts: [{ type: 'text', text: 'summarize the file' }],
      }
      const cfg = toAgentSessionConfig(card, msg)
      expect(cfg.prompt).toBe('summarize the file')
      expect(cfg.description).toBe('remote: user')
      expect(cfg.agentName).toBe('remote')
    })

    it('returns empty prompt when message has no TextPart', () => {
      const card: A2AAgentCard = {
        a2aVersion: A2A_PROTOCOL_VERSION,
        name: 'a',
        description: 'b',
        url: 'http://x',
        capabilities: [],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }
      const msg: A2AMessage = {
        role: 'user',
        parts: [{ type: 'data', data: { x: 1 } }],
      }
      expect(toAgentSessionConfig(card, msg).prompt).toBe('')
    })

    it('handles agent role in description', () => {
      const card: A2AAgentCard = {
        a2aVersion: A2A_PROTOCOL_VERSION,
        name: 'svc',
        description: '',
        url: 'http://x',
        capabilities: [],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }
      const msg: A2AMessage = { role: 'agent', parts: [{ type: 'text', text: 'r' }] }
      expect(toAgentSessionConfig(card, msg).description).toBe('svc: agent')
    })
  })

  describe('fromAgentSessionConfig', () => {
    it('produces a card with the given URL and version', () => {
      const card = fromAgentSessionConfig('myagent', 'does stuff', 'http://localhost:9000')
      expect(card.name).toBe('myagent')
      expect(card.description).toBe('does stuff')
      expect(card.url).toBe('http://localhost:9000')
      expect(card.a2aVersion).toBe(A2A_PROTOCOL_VERSION)
      expect(card.capabilities).toContain('streaming')
      expect(card.defaultInputModes).toEqual(['text'])
      expect(card.defaultOutputModes).toEqual(['text'])
      expect(card.skills).toEqual([])
    })
  })
})

describe('SUBAGENT_AGENT_TYPE_PATTERN', () => {
  const re = new RegExp(SUBAGENT_AGENT_TYPE_PATTERN)

  it.each([
    'explore',
    'implement',
    'review',
    'fix',
    'general',
    'my-custom-type',
    'a2a:peer-1',
    'a2a:local-dev',
    'recipe:refactor-react-component',
    'recipe:add-tests',
  ])('accepts built-in / custom / a2a: / recipe: agentType: %s', (agentType) => {
    expect(re.test(agentType)).toBe(true)
  })

  it.each([
    '',
    'A2A:foo',            // uppercase prefix rejected (regex is lowercase)
    'a2a:',               // empty name
    'a2a:Invalid-Name',   // uppercase in name
    'a2a:foo bar',        // space
    'recipe:',            // empty
    'recipe:Bad_Id',      // underscore rejected (only a-z0-9-)
    ':foo',               // missing prefix
    // 'a2a' is intentionally a valid plain agent name (matches `[a-z][a-z0-9-]*`)
    // — SubagentManager resolves prefix at dispatch time, regex only constrains shape.
    'a2a:foo:bar',        // extra colon
    'a2a:foo/bar',        // slash
    '../etc/passwd',      // path traversal
    'a2a:foo;rm -rf /',   // shell injection
  ])('rejects malformed agentType: %s', (agentType) => {
    expect(re.test(agentType)).toBe(false)
  })
})

describe('A2A constants', () => {
  it('A2A_PROTOCOL_VERSION is pinned to 0.3.0', () => {
    expect(A2A_PROTOCOL_VERSION).toBe('0.3.0')
  })

  it('A2A_DEFAULT_PORT is the documented default', () => {
    expect(A2A_DEFAULT_PORT).toBe(8089)
  })

  it('A2A_DEFAULT_BIND_ADDRESS is loopback (security default)', () => {
    expect(A2A_DEFAULT_BIND_ADDRESS).toBe('127.0.0.1')
  })

  it('A2A_MIN_API_KEY_LENGTH guards against short keys', () => {
    expect(A2A_MIN_API_KEY_LENGTH).toBeGreaterThanOrEqual(16)
  })
})
