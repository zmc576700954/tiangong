/**
 * 把任意抛出物转成可读文本。
 *
 * 主进程把 BizGraphError / InvalidStateTransitionError 以 `toJSON()` 的
 * **plain object** 抛过 IPC（src/main/ipc/utils.ts:227-230），preload 原样透传 ——
 * 所以 renderer 端拿到的往往不是 Error 实例，而是带 `message` 字段的普通对象。
 * 只处理 Error 实例会让这类错误的提示渲染成 "[object Object]"。
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message
  }
  return String(err)
}
