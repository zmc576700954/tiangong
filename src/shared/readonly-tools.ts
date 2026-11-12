/**
 * 只读会话可用的工具白名单。
 *
 * 语义：**只读 = 拿不到任何能改文件或执行命令的工具**。
 * 只放行读与查 —— Read / Glob / Grep / WebFetch。
 *
 * 这份名单取自内置 `explore` 子代理的只读工具集（src/shared/types/subagent.ts
 * 的 `BUILT_IN_AGENT_TYPES`）—— 仓库里已有的权威词汇表，避免臆造工具名。
 */
export const READONLY_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'WebFetch']
