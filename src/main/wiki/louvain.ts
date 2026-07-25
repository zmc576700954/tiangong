/**
 * Louvain 社区发现（纯函数，无 IO 无第三方依赖）
 *
 * 输入无向带权图，输出稳定的社区划分。固定 seed 时结果可复现。
 * resolution 控制粒度（>1 更细，<1 更粗），默认 1.0。
 * 悬空边（引用不存在节点）在构图时被过滤。
 * 自环边在构图与模块度计算中均被忽略。
 */

export interface LouvainGraph {
  nodeIds: string[]
  edges: Array<{ source: string; target: string; weight?: number }>
}

export interface CommunityAssignment {
  communityOf(nodeId: string): string
  communities(): string[]
  modularity(): number
}

export interface LouvainOptions {
  resolution?: number
  seed?: number
}

/** 种子化线性同余随机数（确定性） */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

export function louvain(graph: LouvainGraph, options: LouvainOptions = {}): CommunityAssignment {
  const resolution = options.resolution ?? 1.0
  const rand = lcg(options.seed ?? 42)

  const nodes = new Set(graph.nodeIds)
  const adj = new Map<string, Map<string, number>>()
  for (const id of graph.nodeIds) adj.set(id, new Map())
  let m2 = 0
  for (const e of graph.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue
    if (e.source === e.target) continue
    const w = e.weight ?? 1
    adj.get(e.source)!.set(e.target, (adj.get(e.source)!.get(e.target) ?? 0) + w)
    adj.get(e.target)!.set(e.source, (adj.get(e.target)!.get(e.source) ?? 0) + w)
    m2 += 2 * w
  }

  const ids = graph.nodeIds.slice()
  if (ids.length === 0) {
    return { communityOf: () => '', communities: () => [], modularity: () => 0 }
  }

  const degree = new Map<string, number>()
  for (const id of ids) {
    let d = 0
    for (const w of adj.get(id)!.values()) d += w
    degree.set(id, d)
  }

  let currentAdj = adj
  let currentDegree = degree
  let currentIds = ids
  const currentM2 = m2

  const hierarchy: Array<Map<string, string>> = []

  let improved = true
  while (improved && currentIds.length > 1) {
    improved = false
    const communityOfNode = new Map<string, number>()
    currentIds.forEach((id, i) => communityOfNode.set(id, i))

    const commDegree = new Map<number, number>()
    for (const id of currentIds) {
      const c = communityOfNode.get(id)!
      commDegree.set(c, (commDegree.get(c) ?? 0) + (currentDegree.get(id) ?? 0))
    }

    let localMoved = true
    let guard = 0
    while (localMoved && guard < 10000) {
      localMoved = false
      guard++
      const order = currentIds.slice()
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      for (const node of order) {
        const nodeDeg = currentDegree.get(node) ?? 0
        const curComm = communityOfNode.get(node)!
        const neighCommWeight = new Map<number, number>()
        for (const [nb, w] of currentAdj.get(node)!.entries()) {
          const c = communityOfNode.get(nb)!
          neighCommWeight.set(c, (neighCommWeight.get(c) ?? 0) + w)
        }
        commDegree.set(curComm, (commDegree.get(curComm) ?? 0) - nodeDeg)
        let bestComm = curComm
        let bestGain = 0
        for (const [c, kIn] of neighCommWeight.entries()) {
          const tot = commDegree.get(c) ?? 0
          const gain = kIn - (resolution * tot * nodeDeg) / currentM2
          if (gain > bestGain + 1e-10) {
            bestGain = gain
            bestComm = c
          }
        }
        commDegree.set(bestComm, (commDegree.get(bestComm) ?? 0) + nodeDeg)
        if (bestComm !== curComm) {
          communityOfNode.set(node, bestComm)
          localMoved = true
          improved = true
        }
      }
    }

    const layerMap = new Map<string, string>()
    for (const id of currentIds) layerMap.set(id, String(communityOfNode.get(id)))
    hierarchy.push(layerMap)

    const commCount = new Set(communityOfNode.values()).size
    if (commCount === currentIds.length) break

    const newIds = [...new Set(communityOfNode.values())].map(String)
    const remap = new Map<number, string>()
    newIds.forEach((nid) => remap.set(Number(nid), nid))
    const newAdj = new Map<string, Map<string, number>>()
    for (const nid of newIds) newAdj.set(nid, new Map())
    const newDegree = new Map<string, number>()
    for (const id of currentIds) {
      const c = remap.get(communityOfNode.get(id)!)!
      newDegree.set(c, (newDegree.get(c) ?? 0) + (currentDegree.get(id) ?? 0))
      for (const [nb, w] of currentAdj.get(id)!.entries()) {
        const nbC = remap.get(communityOfNode.get(nb)!)!
        if (nbC === c) continue
        newAdj.get(c)!.set(nbC, (newAdj.get(c)!.get(nbC) ?? 0) + w)
      }
    }
    currentAdj = newAdj
    currentDegree = newDegree
    currentIds = newIds
  }

  const finalCommunity = new Map<string, string>()
  for (const orig of ids) {
    let cur = orig
    for (const layer of hierarchy) {
      const next = layer.get(cur)
      if (next === undefined) break
      cur = next
    }
    finalCommunity.set(orig, cur)
  }

  const commSum = new Map<string, { inW: number; totW: number }>()
  for (const id of ids) {
    const c = finalCommunity.get(id)!
    if (!commSum.has(c)) commSum.set(c, { inW: 0, totW: 0 })
    commSum.get(c)!.totW += degree.get(id) ?? 0
  }
  for (const e of graph.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) continue
    if (finalCommunity.get(e.source) === finalCommunity.get(e.target)) {
      const c = finalCommunity.get(e.source)!
      commSum.get(c)!.inW += 2 * (e.weight ?? 1)
    }
  }
  let q = 0
  if (m2 > 0) {
    for (const { inW, totW } of commSum.values()) {
      q += inW / m2 - resolution * (totW / m2) * (totW / m2)
    }
  }

  const communityList = [...new Set(finalCommunity.values())]
  return {
    communityOf: (nodeId: string) => finalCommunity.get(nodeId) ?? '',
    communities: () => communityList,
    modularity: () => q,
  }
}
