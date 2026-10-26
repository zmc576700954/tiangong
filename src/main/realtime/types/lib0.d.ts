/**
 * Ambient type declarations for lib0 packages.
 *
 * lib0 是 yjs / y-protocols 的依赖，但官方不发布 .d.ts 文件。
 * 我们只声明本项目实际用到的最小 API 集（encoding / decoding）。
 * 真实运行期类型由 lib0 自身保证；这里是给 TypeScript 编译器看的接口。
 */

declare module 'lib0/encoding' {
  export interface Encoder {
    /** 当前已写入位置 */
    readonly pos: number
  }

  export function createEncoder(): Encoder
  export function toUint8Array(encoder: Encoder): Uint8Array
  export function length(encoder: Encoder): number
  export function writeVarUint(encoder: Encoder, value: number): void
  export function writeVarUint8Array(encoder: Encoder, data: Uint8Array): void
  export function writeUint8Array(encoder: Encoder, data: Uint8Array): void
}

declare module 'lib0/decoding' {
  export interface Decoder {
    readonly pos: number
  }

  export function createDecoder(data: Uint8Array): Decoder
  export function readVarUint(decoder: Decoder): number
  export function readVarUint8Array(decoder: Decoder): Uint8Array
}
