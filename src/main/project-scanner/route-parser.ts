/**
 * 路由/API 提取模块
 */

import type { FileAnalysis, RouteInfo } from './types'

export function extractRoutes(fileAnalyses: FileAnalysis[], framework: string): RouteInfo[] {
  const routes: RouteInfo[] = []
  const routeFiles = fileAnalyses.filter((f) => f.purpose === 'route')

  for (const file of routeFiles) {
    const extracted = parseRoutes(file.content, framework, file.filePath)
    routes.push(...extracted)
  }

  // 也从控制器文件中提取
  const controllerFiles = fileAnalyses.filter((f) => f.purpose === 'controller')
  for (const file of controllerFiles) {
    const extracted = parseControllerRoutes(file.content, framework, file.filePath)
    routes.push(...extracted)
  }

  return routes
}

function parseRoutes(content: string, framework: string, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = []

  if (framework.includes('Express') || framework.includes('Node.js')) {
    // Express: app.get('/path', handler)
    const regex = /(?:app|router)\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/g
    let match
    while ((match = regex.exec(content)) !== null) {
      routes.push({ method: match[1].toUpperCase(), path: match[2], file: filePath })
    }
  }

  if (framework.includes('FastAPI') || framework.includes('Flask')) {
    // Python: @app.get("/path") or @router.get("/path")
    const regex = /@(?:app|router)\.(get|post|put|delete|patch|route)\s*\(\s*['"`]([^'"`]+)['"`]/g
    let match
    while ((match = regex.exec(content)) !== null) {
      routes.push({ method: match[1].toUpperCase(), path: match[2], file: filePath })
    }
  }

  if (framework.includes('Go')) {
    // Go: r.GET("/path", handler)
    const regex = /r\.(GET|POST|PUT|DELETE|PATCH|ANY)\s*\(\s*['"`]([^'"`]+)['"`]/g
    let match
    while ((match = regex.exec(content)) !== null) {
      routes.push({ method: match[1], path: match[2], file: filePath })
    }
  }

  if (framework.includes('Spring')) {
    // Java: @GetMapping("/path") or @RequestMapping("/path")
    const regex = /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*['"`]([^'"`]+)['"`]/g
    let match
    while ((match = regex.exec(content)) !== null) {
      routes.push({ path: match[1], file: filePath })
    }
  }

  return routes
}

function parseControllerRoutes(content: string, framework: string, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = []

  if (framework.includes('NestJS')) {
    // NestJS: @Controller('path')
    const ctrlRegex = /@Controller\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/
    const ctrlMatch = ctrlRegex.exec(content)
    const basePath = ctrlMatch ? ctrlMatch[1] : ''

    const methodRegex = /@(?:Get|Post|Put|Delete|Patch)\s*\(\s*['"`]?([^'"`)]+)['"`]?\s*\)/g
    let match
    while ((match = methodRegex.exec(content)) !== null) {
      routes.push({
        path: basePath + match[1],
        file: filePath,
      })
    }
  }

  if (framework.includes('Django')) {
    // Django: path('route', view)
    const regex = /path\s*\(\s*['"`]([^'"`]+)['"`]/g
    let match
    while ((match = regex.exec(content)) !== null) {
      routes.push({ path: match[1], file: filePath })
    }
  }

  return routes
}
