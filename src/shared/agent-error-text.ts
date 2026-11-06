/**
 * 把适配器/SDK 抛出的原始错误文本转成用户能看懂的一句话。
 *
 * 背景：CLI 被取消或审批失效后常以「code 143 / SIGTERM」「code 137 / SIGKILL」
 * 结束，直接把 `SDK error: Claude Code process exited with code 143` 丢进聊天区，
 * 用户只会看到一串错误码，无法判断「命令到底执行了没有」。
 */

export function humanizeAgentErrorText(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) {
    return 'Agent 异常退出（没有更多信息）。请重试；若反复出现，请检查 CLI 安装与登录状态。'
  }
  if (/(?:exited with code|exit code|code)\s*143\b/i.test(text) || /\bSIGTERM\b/i.test(text)) {
    return '本轮已被终止（退出码 143 / SIGTERM）。通常是审批失效或会话取消后 CLI 被回收，本次操作没有执行；请重新发送命令。'
  }
  if (/(?:exited with code|exit code|code)\s*137\b/i.test(text) || /\bSIGKILL\b/i.test(text)) {
    return '本轮被强制终止（退出码 137 / SIGKILL）。环境或进程被系统回收，本次操作没有执行；请重新发送命令。'
  }
  if (/^(?:codex\s+)?SDK error:/i.test(text)) {
    return `Agent 异常退出：${text.replace(/^(?:codex\s+)?SDK error:\s*/i, '')}（请重试；若反复出现，请检查适配器与 CLI 安装状态）`
  }
  return text
}
