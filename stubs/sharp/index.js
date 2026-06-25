/**
 * Stub for `sharp` — replaces the native image-processing module.
 *
 * `@xenova/transformers` pulls in sharp as a hard dependency, but BizGraph
 * only uses transformers for text embeddings (never the image pipeline).
 * The real sharp requires a native addon that must be compiled per-arch and
 * has no prebuilt binary for Electron on win32-arm64, which breaks packaging.
 *
 * transformers' image.js guards every sharp call behind a truthiness check
 * (`else if (sharp)`), so exporting an empty object lets the image pipeline
 * degrade gracefully while the text/embedding path remains fully functional.
 */

module.exports = {}
module.exports.default = {}
