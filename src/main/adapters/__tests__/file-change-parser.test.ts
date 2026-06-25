import { describe, it, expect } from 'vitest'
import { parseFileChanges } from '../file-change-parser'
import type { AgentOutput } from '@shared/types'

describe('parseFileChanges', () => {
  function collect(text: string): AgentOutput[] {
    const outputs: AgentOutput[] = []
    parseFileChanges(text, (output) => outputs.push(output))
    return outputs
  }

  it('parses newly added extensions', () => {
    const text = [
      'edit src/App.vue',
      'update components/Button.svelte',
      'create public/index.html',
      'modify styles/app.css',
      'add config/app.toml',
      'remove config/settings.ini',
    ].join('\n')

    const outputs = collect(text)
    expect(outputs).toHaveLength(6)
    const paths = outputs.map((o) => o.filePath)
    expect(paths).toContain('src/App.vue')
    expect(paths).toContain('components/Button.svelte')
    expect(paths).toContain('public/index.html')
    expect(paths).toContain('styles/app.css')
    expect(paths).toContain('config/app.toml')
    expect(paths).toContain('config/settings.ini')
  })

  it('skips file mentions inside code blocks', () => {
    const text = `
\`\`\`ts
edit src/main.ts
\`\`\`
edit src/real.ts
    `.trim()

    const outputs = collect(text)
    expect(outputs).toHaveLength(1)
    expect(outputs[0].filePath).toBe('src/real.ts')
  })

  it('ignores example/discussion markers', () => {
    const text = `For example, you could edit src/example.ts
but actually modify src/real.ts`
    const outputs = collect(text)
    expect(outputs).toHaveLength(1)
    expect(outputs[0].filePath).toBe('src/real.ts')
  })
})
