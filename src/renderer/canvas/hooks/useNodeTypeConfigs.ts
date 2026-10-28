import { useEffect, useState } from 'react'
import type { NodeTypeConfig } from '@shared/types'

export interface NodeTypeConfigsState {
  /** 类型名 → 配置。IPC 未返回前是空表 */
  configs: Record<string, NodeTypeConfig>
  /** 规则表是否已就绪。成功与失败都算就绪——失败时 `configs` 是空表 */
  loaded: boolean
}

export function useNodeTypeConfigs(): NodeTypeConfigsState {
  const [state, setState] = useState<NodeTypeConfigsState>({ configs: {}, loaded: false })
  useEffect(() => {
    let cancelled = false
    const apply = (configs: Record<string, NodeTypeConfig>) => {
      if (!cancelled) setState({ configs, loaded: true })
    }
    // 调用放进 async 函数：通道不存在时（如测试桩没实现该通道）调用本身是同步抛，
    // Promise 链尾部的 .catch() 接不住同步 throw —— 只有 try/catch 能把它收敛成空表。
    void (async () => {
      try {
        const list = await window.electronAPI['nodeType:listConfigs']()
        apply(Object.fromEntries(list.map(c => [c.type, c])))
      } catch {
        // 取不到规则表 → 空表。空表语义是「所有类型都拒绝」：宁可不给可选项，
        // 也不放行未知规则。这与主进程 validateParentChild 对未知类型返回 false 的语义一致。
        apply({})
      }
    })()
    return () => { cancelled = true }
  }, [])
  return state
}
