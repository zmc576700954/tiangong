import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { BaseAdapter } from '../adapters/base'
import type { AgentSessionConfig, AgentCommand, AgentOutput, ResolvedContext } from '@shared/types'

// Create a concrete adapter for testing
class TestAdapter extends BaseAdapter {
  readonly name = 'test-adapter'
  readonly version = '1.0.0'
  private mockProc?: ChildProcess

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<import('@shared/types').AgentSession> {
    const session = {
      id: `test-${Date.now()}`,
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }

    // Create a mock process
    const stdout = new Readable({ read() {} })
    const stdin = new Writable({ write() {} })
    this.mockProc = {
      stdout,
      stdin,
      kill: vi.fn(),
      killed: false,
      once: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as ChildProcess
    this.registerSession(session, this.mockProc)
    this.attachOutputHandlers(session)
    return session
  }

  protected async doSendCommand(): Promise<void> {
    // no-op for test
  }

  getMockProcess(): ChildProcess | undefined {
    return this.mockProc
  }

  // Expose protected methods for testing
  public testParseFileChanges(text: string): AgentOutput[] {
    const outputs: AgentOutput[] = []
    const handler = (output: AgentOutput) => outputs.push(output)
    this.onOutput(handler)
    this.parseFileChanges(text)
    this.offOutput(handler)
    return outputs
  }

  public testBuildScopePrompt(config: AgentSessionConfig, resolvedContexts?: ResolvedContext[]): string {
    return this.buildScopePrompt(config, resolvedContexts)
  }

  public testBuildSafeEnv(): NodeJS.ProcessEnv {
    return this.buildSafeEnv()
  }

  public testInferChangeType(text: string): 'add' | 'modify' | 'delete' {
    return this.inferChangeType(text)
  }

  // Clean up EventEmitter listeners
  public cleanup(): void {
    this.removeAllListeners('output')
  }
}

describe('BaseAdapter - File Change Parsing', () => {
  let adapter: TestAdapter

  beforeEach(() => {
    adapter = new TestAdapter()
  })

  afterEach(() => {
    adapter.cleanup()
  })

  it('should detect file changes in normal sentences', () => {
    const text = "I'll edit src/services/UserService.ts to fix the bug"
    const outputs = adapter.testParseFileChanges(text)

    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs[0].type).toBe('file_change')
    expect(outputs[0].filePath).toBe('src/services/UserService.ts')
    expect(outputs[0].changeType).toBe('modify')
  })

  it('should ignore changes inside Markdown code blocks', () => {
    const text = `I'll fix the issue.

\`\`\`typescript
// Example: edit src/example.ts
const x = 1
\`\`\`

Now I'll edit src/real/ActualService.ts for real.`

    const outputs = adapter.testParseFileChanges(text)

    const paths = outputs.map((o) => o.filePath)
    expect(paths).not.toContain('src/example.ts')
    expect(paths).toContain('src/real/ActualService.ts')
  })

  it('should ignore example/discussion markers', () => {
    const text = `For example, you could edit src/old/Legacy.ts
But I'll actually edit src/new/Modern.ts`

    const outputs = adapter.testParseFileChanges(text)

    const paths = outputs.map((o) => o.filePath)
    expect(paths).not.toContain('src/old/Legacy.ts')
    expect(paths).toContain('src/new/Modern.ts')
  })

  it('should ignore list items and quotes', () => {
    const text = `> edit src/quoted/File.ts
- edit src/list/File.ts
* edit src/bullet/File.ts

I'll edit src/actual/File.ts`

    const outputs = adapter.testParseFileChanges(text)

    const paths = outputs.map((o) => o.filePath)
    expect(paths).not.toContain('src/quoted/File.ts')
    expect(paths).not.toContain('src/list/File.ts')
    expect(paths).not.toContain('src/bullet/File.ts')
    expect(paths).toContain('src/actual/File.ts')
  })

  it('should require directory separator in file paths', () => {
    const text = 'I will edit test.ts, and I will also edit src/utils/test.ts'
    const outputs = adapter.testParseFileChanges(text)

    const paths = outputs.map((o) => o.filePath)
    expect(paths).not.toContain('test.ts')
    expect(paths).toContain('src/utils/test.ts')
  })

  it('should infer add type for create/add actions', () => {
    expect(adapter.testInferChangeType('create file.ts')).toBe('add')
    expect(adapter.testInferChangeType('add src/new.ts')).toBe('add')
  })

  it('should infer delete type for delete/remove actions', () => {
    expect(adapter.testInferChangeType('delete file.ts')).toBe('delete')
    expect(adapter.testInferChangeType('remove src/old.ts')).toBe('delete')
  })

  it('should default to modify type', () => {
    expect(adapter.testInferChangeType('edit file.ts')).toBe('modify')
    expect(adapter.testInferChangeType('update src/x.ts')).toBe('modify')
  })
})

describe('BaseAdapter - Scope Prompt', () => {
  let adapter: TestAdapter

  beforeEach(() => {
    adapter = new TestAdapter()
  })

  afterEach(() => {
    adapter.cleanup()
  })

  it('should build scope prompt with all sections', () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/project',
      nodeTitle: 'Auth Module',
      acceptanceCriteria: ['User can login', 'Token expires in 1h'],
      allowedFiles: ['src/auth.ts'],
      forbiddenFiles: ['src/payment.ts'],
      invariantRules: ['Must use JWT'],
      upstreamContext: 'User service provides data',
      downstreamContext: 'Session stores tokens',
      bugContext: [{ bugId: '1', title: 'Login fail', description: 'Timeout', severity: 'high' }],
    }

    const prompt = adapter.testBuildScopePrompt(config)

    expect(prompt).toContain('业务节点：Auth Module')
    expect(prompt).toContain('## 验收标准')
    expect(prompt).toContain('- User can login')
    expect(prompt).toContain('## 允许修改的文件（白名单）')
    expect(prompt).toContain('- src/auth.ts')
    expect(prompt).toContain('## 禁止修改的文件（黑名单）')
    expect(prompt).toContain('- src/payment.ts')
    expect(prompt).toContain('## 业务不变量')
    expect(prompt).toContain('- Must use JWT')
    expect(prompt).toContain('## 上游契约')
    expect(prompt).toContain('## 下游契约')
    expect(prompt).toContain('## 待修复 Bug')
    expect(prompt).toContain('### Login fail [high]')
  })

  it('should omit empty sections', () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/project',
      nodeTitle: 'Simple Node',
      acceptanceCriteria: [],
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
    }

    const prompt = adapter.testBuildScopePrompt(config)

    expect(prompt).toContain('业务节点：Simple Node')
    expect(prompt).not.toContain('验收标准')
    expect(prompt).not.toContain('白名单')
    expect(prompt).not.toContain('黑名单')
    expect(prompt).not.toContain('业务不变量')
    expect(prompt).not.toContain('上游契约')
    expect(prompt).not.toContain('下游契约')
    expect(prompt).not.toContain('待修复 Bug')
  })
})

describe('BaseAdapter - Safe Environment', () => {
  let adapter: TestAdapter
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PATH: '/usr/bin',
      HOME: '/home/user',
      BIZGRAPH_SECRET_KEY: 'should-be-filtered',
      ELECTRON_INTERNAL_FLAG: 'should-be-filtered',
      NODE_OPTIONS: '--inspect',
      npm_config_cache: '/tmp/npm',
      USER: 'testuser',
      SSH_AUTH_SOCK: '/tmp/ssh-agent',
    }
    adapter = new TestAdapter()
  })

  afterEach(() => {
    process.env = originalEnv
    adapter.cleanup()
  })

  it('should filter BIZGRAPH_ prefixed variables', () => {
    const env = adapter.testBuildSafeEnv()
    expect(env.BIZGRAPH_SECRET_KEY).toBeUndefined()
  })

  it('should filter ELECTRON_ prefixed variables', () => {
    const env = adapter.testBuildSafeEnv()
    expect(env.ELECTRON_INTERNAL_FLAG).toBeUndefined()
  })

  it('should filter NODE_ prefixed variables', () => {
    const env = adapter.testBuildSafeEnv()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('should filter npm_ prefixed variables', () => {
    const env = adapter.testBuildSafeEnv()
    expect(env.npm_config_cache).toBeUndefined()
  })

  it('should preserve allowed system variables', () => {
    const env = adapter.testBuildSafeEnv()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/user')
    expect(env.USER).toBe('testuser')
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent')
  })
})

describe('BaseAdapter - Session Lifecycle', () => {
  let adapter: TestAdapter

  beforeEach(() => {
    adapter = new TestAdapter()
  })

  afterEach(() => {
    adapter.cleanup()
  })

  it('should emit output events', async () => {
    const outputs: AgentOutput[] = []
    const handler = (output: AgentOutput) => outputs.push(output)
    adapter.onOutput(handler)

    const config: AgentSessionConfig = {
      workingDirectory: '/project',
      nodeTitle: 'Test',
      acceptanceCriteria: [],
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
    }

    await adapter.startSession(config)
    const proc = adapter.getMockProcess()
    expect(proc).toBeDefined()

    // Simulate stdout data
    proc!.stdout!.emit('data', Buffer.from('Hello from agent\n'))

    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs[0].type).toBe('stdout')
    expect(outputs[0].data).toBe('Hello from agent\n')

    adapter.offOutput(handler)
  })

  it('should throw SessionNotFoundError for unknown session', async () => {
    const command: AgentCommand = { type: 'implement', description: 'test', targetNodeId: 'n1' }
    await expect(adapter.sendCommand('nonexistent-session', command)).rejects.toThrow('Session nonexistent-session not found')
  })

  it('should not throw when removing non-existent listener', () => {
    expect(() => adapter.offOutput(() => {})).not.toThrow()
  })
})

describe('buildScopePrompt with resolved contexts', () => {
  let adapter: TestAdapter

  beforeEach(() => {
    adapter = new TestAdapter()
  })

  afterEach(() => {
    adapter.cleanup()
  })

  it('appends resolved contexts to scope prompt', () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/test',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test Node',
      acceptanceCriteria: [],
    }

    const resolved: ResolvedContext[] = [
      {
        type: 'node',
        id: 'n1',
        label: 'Login',
        content: '节点: Login (feature)\n描述: Login flow',
        tokenEstimate: 10,
      },
      {
        type: 'file',
        id: '/src/auth.ts',
        label: 'auth.ts',
        content: 'export function login() {}',
        tokenEstimate: 5,
      },
    ]

    const prompt = adapter.testBuildScopePrompt(config, resolved)

    expect(prompt).toContain('# 业务节点：Test Node')
    expect(prompt).toContain('## 附加上下文')
    expect(prompt).toContain('### Login (node)')
    expect(prompt).toContain('Login flow')
    expect(prompt).toContain('### auth.ts (file)')
    expect(prompt).toContain('export function login')
  })

  it('does not add context section when resolved is empty', () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/test',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test Node',
      acceptanceCriteria: [],
    }

    const prompt = adapter.testBuildScopePrompt(config, [])
    expect(prompt).not.toContain('## 附加上下文')
  })

  it('does not add context section when resolved is undefined', () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/test',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test Node',
      acceptanceCriteria: [],
    }

    const prompt = adapter.testBuildScopePrompt(config)
    expect(prompt).not.toContain('## 附加上下文')
  })
})
