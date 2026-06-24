/**
 * Shared type guard: Error-with-code detection.
 * Used by main-process modules (ipc/fs, settings, scope-guard, project-scanner, etc.).
 */

/**
 * Type guard that checks whether a thrown value is an Error with a `code` property.
 *
 * Node.js system errors (ENOENT, EACCES, EPERM, etc.) carry a `code` property;
 * this guard narrows the type so callers can safely access `err.code`.
 *
 * Note: this guard matches *any* Error subclass that has a `code` property,
 * not just Node.js system errors. If you need stricter filtering (e.g. only
 * `"E"`-prefixed codes), check `err.code` after narrowing.
 */
export function isErrorWithCode(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
