/**
 * 层级工具 —— 纯函数，不碰数据库
 *
 * 防环逻辑只写一份：
 * - HierarchyService.reparent（Task 6）传数据库查询作为 parentOf
 * - AI 写入路径（Task 8）传内存映射作为 parentOf
 *
 * 两者用**同一个**函数、同一个参数顺序 —— 防环一旦分叉，两条路径的判定就会不一致。
 */

/**
 * ancestorId 是否为 childId 的后代（含自身）。
 *
 * parentOf 由调用方提供 —— 可以是数据库查询，也可以是内存映射。
 * 沿 parentId 上溯，带 visited 集合防死循环（存量孤儿数据可能成环）。
 *
 * 注意参数顺序：**祖先在前，后代在后**。
 * 「X 是不是 Y 的祖先」——把两者写反会让防环守卫变成空操作。
 */
export function isDescendant(
  ancestorId: string,
  childId: string,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (ancestorId === childId) return true
  const visited = new Set<string>()
  let cur: string | null | undefined = parentOf(childId)
  while (cur) {
    if (visited.has(cur)) return false
    visited.add(cur)
    if (cur === ancestorId) return true
    cur = parentOf(cur)
  }
  return false
}
