/**
 * Minimal type declarations for `yjs`.
 *
 * The published yjs 13.x tarball we have doesn't ship .d.ts files.
 * We declare only the surface area our realtime code uses.
 */

declare module 'yjs' {
  // ============================================================
  // Core types
  // ============================================================

  export class Doc {
    constructor()
    /** A unique client id (changes each construction in a real client). */
    clientID: number
    /** Internal transaction id counter. */
    store: DocStore
    /** Run a callback inside a single transaction. */
    transact(fn: () => void, origin?: unknown): void
    /** Get or create a sub-type by name. */
    getMap<T>(name: string): YMap<T>
    /** Get or create a Y.Array by name. */
    getArray<T>(name: string): YArray<T>
    /** Get or create a Y.Text by name. */
    getText(name: string): YText
    /** Get or create an XmlElement by name. */
    getXmlElement(name: string): YXmlElement
    /** Subscribe to any update. */
    on(name: 'update', handler: (update: Uint8Array, origin: unknown, doc: Doc, tr: Transaction) => void): void
    off(name: 'update', handler: (update: Uint8Array, origin: unknown, doc: Doc, tr: Transaction) => void): void
    /** Subscribe to updates with full event detail. */
    on(name: 'updateV2', handler: (update: Uint8Array, origin: unknown, doc: Doc, tr: Transaction) => void): void
    /** Encode state as binary update. */
    toJSON(): unknown
    destroy(): void
  }

  export interface DocStore {
    clients: Map<number, Array<unknown>>
  }

  export class Transaction {
    doc: Doc
    origin: unknown
    /** Map of typeName -> observers fired during this transaction. */
    changed: Map<string, { type: AbstractType<unknown>; changes: Map<unknown, YDelta> }>
  }

  export type DeltaAction = 'add' | 'update' | 'delete'

  export interface YDelta {
    action: DeltaAction
    oldValue?: unknown
  }

  export class AbstractType<T> {
    /** Subscribe to local changes. */
    observe(handler: (event: YEvent<this>, transaction: Transaction) => void): void
    unobserve(handler: (event: YEvent<this>, transaction: Transaction) => void): void
    /** Subscribe to changes in this type and all nested types. */
    observeDeep(handler: (events: Array<YEvent<AbstractType<unknown>>>, transaction: Transaction) => void): void
    unobserveDeep(handler: (events: Array<YEvent<AbstractType<unknown>>>, transaction: Transaction) => void): void
    /** Parent doc ref. */
    doc: Doc | null
    /** Iteration helpers. */
    forEach(callback: (value: T, key: string, map: this) => void): void
    /** Size accessor. */
    readonly size: number
    /** Get an item by key (string). */
    get(key: string): T | undefined
    /** Set an item by key. */
    set(key: string, value: T): void
    /** Delete an item by key. */
    delete(key: string): void
  }

  export class YMap<T> extends AbstractType<T> {
    constructor()
  }

  // Alias used by Yjs source (`YMap as Map`); keep both for completeness.
  export { YMap as Map }

  export class YArray<T> extends AbstractType<T> {
    constructor()
  }

  export class YText extends AbstractType<unknown> {
    constructor()
  }

  export class YXmlElement extends AbstractType<unknown> {
    constructor()
  }

  // ============================================================
  // Events
  // ============================================================

  export interface YEvent<T extends AbstractType<unknown>> {
    /** Type that emitted the event (target). */
    target: T
    /** Path from the root type to the changed sub-type. */
    path: Array<unknown>
    /** Underlying transaction. */
    transaction: Transaction
    /** For Y.YMapEvent, the per-key delta map. */
    changes?: YMapEventChanges
  }

  export interface YMapEvent<T> extends Omit<YEvent<YMap<T>>, 'changes'> {
    /** Always present for YMapEvent; YEvent makes it optional so we re-state as required. */
    changes: YMapEventChanges
  }

  export interface YMapEventChanges {
    keys: Map<string, YDelta>
  }

  // ============================================================
  // Free helpers
  // ============================================================

  export function encodeStateAsUpdate(doc: Doc, encodedStateVector?: Uint8Array): Uint8Array
  export function applyUpdate(doc: Doc, update: Uint8Array, origin?: unknown): void
  export function encodeStateVector(doc: Doc): Uint8Array
}
