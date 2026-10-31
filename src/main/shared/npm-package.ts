/**
 * npm 包名校验 —— 唯一的实现。
 *
 * 放在 main/shared 而不是 settings.ts：settings.ts 依赖 electron，而 IPC 边界
 * （src/main/ipc/settings.ts）需要在**写盘之前**就用它把渲染进程送来的包名挡掉 ——
 * 那时还不该把整个 settings 模块拉进来。
 *
 * 规则与 npm 自己的包名限制一致：不允许路径分隔符、空格、shell 元字符
 * （防命令注入），也不允许 `@latest` 这类版本后缀（`pkg@latest` 不是合法的包名参数）。
 */

/** npm 包名格式验证：防命令注入 */
export function validateNpmPackageName(pkg: string): boolean {
  return /^(@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/.test(pkg)
}
