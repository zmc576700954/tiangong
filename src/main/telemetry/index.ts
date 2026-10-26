/**
 * OpenTelemetry 导出模块
 *
 * Phase D6：把 Agent / Subagent / MCP / Recipe 的关键事件采样为 OTLP spans。
 *
 * 设计目标：
 * 1. **零开销默认** — settings.telemetry.otlpEndpoint 未设置时，所有函数都是 noop，
 *    调用方无需写 `if (telemetry.enabled)` 判断。
 * 2. **best-effort** — 初始化失败 / OTLP 导出失败 / shutdown 超时 一律不抛错，
 *    telemetry 是观察性设施，不应阻塞业务。
 * 3. **轻量** — 只引 `sdk-node` + `otlp-http` + `api`，不引 metrics/logs SDK，
 *    避免 electron-builder 打包膨胀。
 *
 * 用法：
 *   - 在 `src/main/index.ts` 启动时调用一次 `initTelemetry({ otlpEndpoint })`。
 *   - 业务代码用 `withSpan('bizgraph.agent.start', async (span) => { ... })`
 *     或 `recordAdapterCall('claude-code', true)` 记录事件。
 *
 * 边界（CLAUDE.md "Boundaries with Agent CLI" 一致）：
 *   - 不污染 Agent CLI 输入；只观察 BizGraph 自身的事件。
 *   - 失败一律静默吞掉，绝不向上抛。
 */

import { trace, type Span, type SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api'

const TRACER_NAME = 'bizgraph'
const SHUTDOWN_TIMEOUT_MS = 5000

let sdkInstance: { shutdown: () => Promise<void> } | null = null
let initialized = false
let initPromise: Promise<void> | null = null

export interface TelemetryConfig {
  /** OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`)。空字符串 / undefined = 关闭。 */
  otlpEndpoint?: string
  /** Resource `service.name`；默认 `bizgraph`。 */
  serviceName?: string
  /** Resource `service.version`；默认 `0.0.0`。 */
  serviceVersion?: string
}

/** 初始化 telemetry。多次调用幂等。失败绝不抛。 */
export function initTelemetry(config: TelemetryConfig): Promise<void> {
  if (initPromise) return initPromise
  initPromise = doInit(config).finally(() => {
    // init 完成（成功或失败）后清空 promise 缓存，允许后续显式 shutdown 后重新 init
    if (!initialized) initPromise = null
  })
  return initPromise
}

async function doInit(config: TelemetryConfig): Promise<void> {
  if (initialized) return
  const endpoint = config.otlpEndpoint?.trim()
  if (!endpoint) {
    // 默认关闭：no-op，零开销
    return
  }
  try {
    // 动态 import 避免启动阶段同步加载重 SDK；失败也只是 best-effort
    const [{ NodeSDK }, { OTLPTraceExporter }, resourcesMod, semconvMod] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ])

    const resourceAttrs: Record<string, string> = {
      [semconvMod.ATTR_SERVICE_NAME]: config.serviceName ?? 'bizgraph',
    }
    if (config.serviceVersion) {
      resourceAttrs['service.version'] = config.serviceVersion
    }

    const sdk = new NodeSDK({
      resource: new resourcesMod.Resource(resourceAttrs),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
    })
    sdk.start()
    sdkInstance = sdk as unknown as { shutdown: () => Promise<void> }
    initialized = true
  } catch {
    // 任何初始化失败一律吞掉 — telemetry 不应阻塞主流程
    sdkInstance = null
    initialized = false
  }
}

/** 关闭 SDK，best-effort。SIGTERM 时自动调用。 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdkInstance) return
  try {
    await Promise.race([
      sdkInstance.shutdown(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('shutdown timeout')), SHUTDOWN_TIMEOUT_MS),
      ),
    ])
  } catch {
    // best-effort
  } finally {
    sdkInstance = null
    initialized = false
    initPromise = null
  }
}

/** 测试/调试用：当前是否已初始化 + 配置了 endpoint。 */
export function isTelemetryActive(): boolean {
  return initialized && sdkInstance !== null
}

/** 获取当前 BizGraph tracer。未初始化时为 noop tracer（API 兼容）。 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME)
}

/**
 * 在 span 内执行异步函数。异常会被记录到 span status 并重新抛出。
 *
 * 用法：
 *   await withSpan('bizgraph.agent.start', async (span) => {
 *     span.setAttribute('adapter', 'claude-code')
 *     return agentManager.startSession(...)
 *   }, { kind: SpanKind.INTERNAL })
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: { kind?: SpanKind; attributes?: Record<string, string | number | boolean> },
): Promise<T> {
  const tracer = getTracer()
  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      span.recordException(error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      throw err
    } finally {
      span.end()
    }
  })
}

/**
 * 记录适配器调用计数器。
 *
 * spec 要求 `bizgraph.adapter.call{service, success}` 是 counter；
 * 我们没有装 metrics SDK，所以等价做法是生成一个零持续时间的 span，
 * 让后端用 span count metric 聚合（Prometheus / Tempo 都支持）。
 */
export function recordAdapterCall(service: string, success: boolean, responseTimeMs?: number): void {
  const tracer = getTracer()
  const span = tracer.startSpan('bizgraph.adapter.call', {
    attributes: {
      service,
      success,
      ...(typeof responseTimeMs === 'number' ? { response_time_ms: responseTimeMs } : {}),
    },
  })
  span.end()
}

/**
 * 在已存在的 parent context 内创建子 span。
 * 用于把 subagent / command 嵌入到 startSession span 下，串起完整调用链。
 */
export function startChildSpan(
  name: string,
  options?: { kind?: SpanKind; attributes?: Record<string, string | number | boolean> },
): Span {
  return getTracer().startSpan(name, options)
}