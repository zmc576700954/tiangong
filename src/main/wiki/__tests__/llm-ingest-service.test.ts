import { describe, it, expect, beforeEach } from 'vitest'
import { LlmIngestService, type AgentRunner, MAX_LLM_FILE_SIZE } from '../llm-ingest-service'
import { IpcError, ErrorCode } from '../../errors'
import type { GraphNode, GraphEdge } from '@shared/types'

class MemNodeRepo {
  nodes = new Map<string, GraphNode>()
  private seq = 0
  findById = (id: string) => this.nodes.get(id) ?? null
  listByGraph = (gid: string) => [...this.nodes.values()].filter((n) => n.graphId === gid)
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    const n = { ...data, id: `n${this.seq++}`, createdAt: '', updatedAt: '' } as GraphNode
    this.nodes.set(n.id, n); return n
  }
  update(id: string, data: Partial<GraphNode>): GraphNode {
    const u = { ...this.nodes.get(id)!, ...data }; this.nodes.set(id, u); return u
  }
}
class MemEdgeRepo {
  edges = new Map<string, GraphEdge>(); private seq = 0
  create(d: Omit<GraphEdge, 'id'>): GraphEdge { const e = { ...d, id: `e${this.seq++}` } as GraphEdge; this.edges.set(e.id, e); return e }
  delete(id: string) { this.edges.delete(id) }
  listByGraph = (gid: string) => [...this.edges.values()].filter((e) => e.graphId === gid)
}

const readFile = async (p: string) => `raw content of ${p}`
const oversizedReadFile = async (_p: string) => 'x'.repeat(MAX_LLM_FILE_SIZE + 1)

describe('LlmIngestService.ingestWithLlm', () => {
  let nodeRepo: MemNodeRepo
  let edgeRepo: MemEdgeRepo
  beforeEach(() => { nodeRepo = new MemNodeRepo(); edgeRepo = new MemEdgeRepo() })

  it('LLM 输出带 frontmatter 时按标题新建 draft 节点', async () => {
    const runner: AgentRunner = async () => '---\ntitle: 支付流程\n---\n\n# 支付流程\n\n见 [[订单]]。'
    const r = await LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.created.length).toBe(1)
    expect(r.created[0].title).toBe('支付流程')
  })

  it('同名（大小写不敏感）追加而非新建', async () => {
    nodeRepo.nodes.set('x', {
      id: 'x', type: 'wiki-page', status: 'draft', title: '支付流程',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
      wikiContent: '# 旧内容', createdAt: '', updatedAt: '',
    } as GraphNode)
    const runner: AgentRunner = async () => '---\ntitle: 支付流程\n---\n\n# 支付流程\n\n新增段落。'
    const r = await LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.created.length).toBe(0)
    expect(r.updated.length).toBe(1)
    expect(nodeRepo.nodes.get('x')!.wikiContent).toContain('旧内容')
    expect(nodeRepo.nodes.get('x')!.wikiContent).toContain('新增段落')
  })

  it('frontmatter 非法时回退：文件名做标题并记 ingestWarning', async () => {
    const runner: AgentRunner = async () => '---\n: bad yaml [\n---\n\n正文内容'
    const r = await LlmIngestService.ingestWithLlm('g1', ['/dir/订单.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.created.length).toBe(1)
    const node = nodeRepo.nodes.get(r.created[0].id)!
    expect(node.title).toBe('订单')
    expect(node.wikiContent).toContain('正文内容')
    expect((node.wikiMeta as { ingestWarning?: string }).ingestWarning).toBe('LLM 输出 frontmatter 无法解析，已回退为文件名标题 + 原文整体导入')
  })

  it('frontmatter 回退时正文中的水平分隔线不被误截断', async () => {
    const runner: AgentRunner = async () => '---\n: bad\n---\n\nA\n\n---\n\nB'
    const r = await LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.created.length).toBe(1)
    const node = nodeRepo.nodes.get(r.created[0].id)!
    expect(node.wikiContent).toContain('A')
    expect(node.wikiContent).toContain('B')
  })

  it('单文件失败不阻塞整批', async () => {
    let call = 0
    const runner: AgentRunner = async () => {
      call++
      if (call === 2) throw new Error('agent timeout on second file')
      return '---\ntitle: 好页面\n---\n\n# 好页面'
    }
    const r = await LlmIngestService.ingestWithLlm('g1', ['/good.md', '/bad.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.failed.length).toBe(1)
    expect(r.created.length).toBe(1)
  })

  it('agent 首个文件即失败时整单抛 IpcError', async () => {
    const runner: AgentRunner = async () => { throw new Error('claude-code not found') }
    await expect(
      LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner),
    ).rejects.toThrow(IpcError)
    await expect(
      LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner),
    ).rejects.toMatchObject({ code: ErrorCode.AGENT_ADAPTER_ERROR, message: expect.stringContaining('LLM 不可用，请改用规则式导入') })
  })

  it('超大文件进入 failed 且不走 agentRunner', async () => {
    let called = false
    const runner: AgentRunner = async () => { called = true; return '---\ntitle: 不应触发\n---\n\n# 不应触发' }
    const r = await LlmIngestService.ingestWithLlm('g1', ['/big.md'], 'online', nodeRepo, edgeRepo, oversizedReadFile, runner)
    expect(r.created).toHaveLength(0)
    expect(r.failed.length).toBe(1)
    expect(r.failed[0].error).toContain('超过 LLM 提炼上限')
    expect(called).toBe(false)
  })

  it('prompt 中包含已有页面标题供 wikilink 对齐', async () => {
    nodeRepo.nodes.set('e1', {
      id: 'e1', type: 'wiki-page', status: 'confirmed', title: '库存',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 }, createdAt: '', updatedAt: '',
    } as GraphNode)
    let seenPrompt = ''
    const runner: AgentRunner = async (p) => { seenPrompt = p; return '---\ntitle: X\n---\n\n# X' }
    await LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(seenPrompt).toContain('库存')
  })
})
