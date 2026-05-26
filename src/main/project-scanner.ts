/**
 * 项目结构扫描器
 * 分析项目代码结构，自动生成思维导图初始节点
 *
 * 能力层级：
 * L1 - 文件系统扫描：目录结构、配置文件识别
 * L2 - 内容分析：读取关键文件提取路由/API/实体
 * L3 - Agent 增强（可选）：调用 Claude Code 等 Agent 进行深度业务分析
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectScanResult, ScanModule, ScanProcess, ScanFeature } from '@shared/types'

// ============================================
// 类型扩展
// ============================================

interface FileAnalysis {
  filePath: string
  content: string
  language: string
  purpose: 'route' | 'controller' | 'service' | 'model' | 'entity' | 'component' | 'config' | 'util' | 'other'
}

interface RouteInfo {
  method?: string
  path: string
  handler?: string
  file?: string
}

interface EntityInfo {
  name: string
  fields: string[]
  file?: string
}

// ============================================
// 主扫描器类
// ============================================

export class ProjectScanner {
  private projectPath: string = ''
  private structure: string[] = []
  private fileAnalyses: FileAnalysis[] = []

  /**
   * 扫描项目目录（主入口）
   */
  async scan(projectPath: string): Promise<ProjectScanResult> {
    this.projectPath = projectPath
    const projectName = path.basename(projectPath)

    // 1. 读取配置文件
    const configs = await this.readConfigs(projectPath)

    // 2. 检测框架类型
    const framework = this.detectFramework(configs, projectPath)

    // 3. 扫描目录结构
    this.structure = await this.scanDirectory(projectPath)

    // 4. 内容分析（读取关键文件）
    this.fileAnalyses = await this.analyzeKeyFiles(projectPath, framework)

    // 5. 提取路由/API 信息
    const routes = this.extractRoutes(framework)

    // 6. 提取实体/模型信息
    const entities = this.extractEntities(framework)

    // 7. 构建模块列表
    const modules = this.buildModules(projectName, framework, configs, routes, entities)

    return {
      projectName,
      projectPath,
      framework,
      packageJson: configs.packageJson
        ? {
            name: (configs.packageJson.name as string) ?? projectName,
            description: (configs.packageJson.description as string) ?? '',
            version: (configs.packageJson.version as string) ?? '0.0.0',
            scripts: configs.packageJson.scripts as Record<string, string> | undefined,
            dependencies: Object.keys((configs.packageJson.dependencies as Record<string, string>) ?? {}),
            devDependencies: Object.keys((configs.packageJson.devDependencies as Record<string, string>) ?? {}),
          }
        : null,
      modules,
    }
  }

  // ============================================
  // 1. 配置文件读取
  // ============================================

  private async readConfigs(projectPath: string): Promise<{
    packageJson: Record<string, unknown> | null
    goMod: string | null
    cargoToml: Record<string, unknown> | null
    pyprojectToml: Record<string, unknown> | null
    requirementsTxt: string | null
    pomXml: string | null
    gradleBuild: string | null
    gemfile: string | null
    composerJson: Record<string, unknown> | null
  }> {
    const configs: ReturnType<typeof this.readConfigs> extends Promise<infer T> ? T : never = {
      packageJson: null,
      goMod: null,
      cargoToml: null,
      pyprojectToml: null,
      requirementsTxt: null,
      pomXml: null,
      gradleBuild: null,
      gemfile: null,
      composerJson: null,
    }

    // package.json
    try {
      const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8')
      configs.packageJson = JSON.parse(raw)
    } catch { /* ignore */ }

    // go.mod
    try {
      configs.goMod = await fs.readFile(path.join(projectPath, 'go.mod'), 'utf-8')
    } catch { /* ignore */ }

    // Cargo.toml
    try {
      const raw = await fs.readFile(path.join(projectPath, 'Cargo.toml'), 'utf-8')
      configs.cargoToml = this.parseToml(raw)
    } catch { /* ignore */ }

    // pyproject.toml
    try {
      const raw = await fs.readFile(path.join(projectPath, 'pyproject.toml'), 'utf-8')
      configs.pyprojectToml = this.parseToml(raw)
    } catch { /* ignore */ }

    // requirements.txt
    try {
      configs.requirementsTxt = await fs.readFile(path.join(projectPath, 'requirements.txt'), 'utf-8')
    } catch { /* ignore */ }

    // pom.xml
    try {
      configs.pomXml = await fs.readFile(path.join(projectPath, 'pom.xml'), 'utf-8')
    } catch { /* ignore */ }

    // build.gradle
    try {
      configs.gradleBuild = await fs.readFile(path.join(projectPath, 'build.gradle'), 'utf-8')
    } catch { /* ignore */ }

    // Gemfile
    try {
      configs.gemfile = await fs.readFile(path.join(projectPath, 'Gemfile'), 'utf-8')
    } catch { /* ignore */ }

    // composer.json
    try {
      const raw = await fs.readFile(path.join(projectPath, 'composer.json'), 'utf-8')
      configs.composerJson = JSON.parse(raw)
    } catch { /* ignore */ }

    return configs
  }

  // ============================================
  // 2. 框架检测
  // ============================================

  private detectFramework(
    configs: Awaited<ReturnType<typeof this.readConfigs>>,
    projectPath: string,
  ): string {
    // Go 项目
    if (configs.goMod) return this.detectGoFramework(configs.goMod)

    // Rust 项目
    if (configs.cargoToml) return this.detectRustFramework(configs.cargoToml)

    // Python 项目
    if (configs.pyprojectToml || configs.requirementsTxt) {
      return this.detectPythonFramework(configs.pyprojectToml, configs.requirementsTxt)
    }

    // Java 项目
    if (configs.pomXml || configs.gradleBuild) {
      return this.detectJavaFramework(configs.pomXml, configs.gradleBuild)
    }

    // Ruby 项目
    if (configs.gemfile) return this.detectRubyFramework(configs.gemfile)

    // PHP 项目
    if (configs.composerJson) return this.detectPhpFramework(configs.composerJson)

    // Node.js 项目
    if (configs.packageJson) return this.detectNodeFramework(configs.packageJson)

    // 根据目录特征推断
    return this.detectByDirectory(this.structure)
  }

  private detectGoFramework(goMod: string): string {
    if (goMod.includes('github.com/gin-gonic/gin')) return 'Go + Gin'
    if (goMod.includes('github.com/labstack/echo')) return 'Go + Echo'
    if (goMod.includes('github.com/gofiber/fiber')) return 'Go + Fiber'
    if (goMod.includes('github.com/gorilla/mux')) return 'Go + Gorilla Mux'
    if (goMod.includes('github.com/go-kratos/kratos')) return 'Go + Kratos'
    if (goMod.includes('google.golang.org/grpc')) return 'Go + gRPC'
    return 'Go'
  }

  private detectRustFramework(cargoToml: Record<string, unknown>): string {
    const deps = {
      ...(cargoToml.dependencies as Record<string, unknown> ?? {}),
      ...(cargoToml['dev-dependencies'] as Record<string, unknown> ?? {}),
    }
    if (deps.actix_web || deps['actix-web']) return 'Rust + Actix Web'
    if (deps.axum) return 'Rust + Axum'
    if (deps.rocket) return 'Rust + Rocket'
    if (deps.tide) return 'Rust + Tide'
    if (deps.warp) return 'Rust + Warp'
    if (deps.tokio) return 'Rust + Tokio'
    return 'Rust'
  }

  private detectPythonFramework(
    pyproject: Record<string, unknown> | null,
    requirements: string | null,
  ): string {
    const allText = JSON.stringify(pyproject) + (requirements ?? '')
    if (allText.includes('fastapi')) return 'Python + FastAPI'
    if (allText.includes('flask')) return 'Python + Flask'
    if (allText.includes('django')) return 'Python + Django'
    if (allText.includes('tornado')) return 'Python + Tornado'
    if (allText.includes('bottle')) return 'Python + Bottle'
    if (allText.includes('starlette')) return 'Python + Starlette'
    if (allText.includes('grpc')) return 'Python + gRPC'
    return 'Python'
  }

  private detectJavaFramework(pomXml: string | null, gradle: string | null): string {
    const allText = (pomXml ?? '') + (gradle ?? '')
    if (allText.includes('spring-boot')) return 'Java + Spring Boot'
    if (allText.includes('spring')) return 'Java + Spring'
    if (allText.includes('quarkus')) return 'Java + Quarkus'
    if (allText.includes('micronaut')) return 'Java + Micronaut'
    if (allText.includes('vert.x') || allText.includes('vertx')) return 'Java + Vert.x'
    if (allText.includes('javalin')) return 'Java + Javalin'
    if (allText.includes('sparkjava')) return 'Java + Spark'
    return 'Java'
  }

  private detectRubyFramework(gemfile: string): string {
    if (gemfile.includes('rails')) return 'Ruby on Rails'
    if (gemfile.includes('sinatra')) return 'Ruby + Sinatra'
    if (gemfile.includes('hanami')) return 'Ruby + Hanami'
    if (gemfile.includes('grape')) return 'Ruby + Grape'
    if (gemfile.includes('roda')) return 'Ruby + Roda'
    return 'Ruby'
  }

  private detectPhpFramework(composer: Record<string, unknown>): string {
    const deps = {
      ...(composer.require as Record<string, unknown> ?? {}),
      ...(composer['require-dev'] as Record<string, unknown> ?? {}),
    }
    if (deps['laravel/framework']) return 'PHP + Laravel'
    if (deps['symfony/framework-bundle']) return 'PHP + Symfony'
    if (deps['slim/slim']) return 'PHP + Slim'
    if (deps['cakephp/cakephp']) return 'PHP + CakePHP'
    if (deps['codeigniter/framework']) return 'PHP + CodeIgniter'
    if (deps['zendframework/zend-framework']) return 'PHP + Zend'
    return 'PHP'
  }

  private detectNodeFramework(pkg: Record<string, unknown>): string {
    const deps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    }

    if (deps['next']) return 'Next.js'
    if (deps['nuxt']) return 'Nuxt.js'
    if (deps['remix'] || deps['@remix-run/react']) return 'Remix'
    if (deps['sveltekit'] || deps['@sveltejs/kit']) return 'SvelteKit'
    if (deps['astro']) return 'Astro'
    if (deps['electron']) return 'Electron + React'
    if (deps['react'] && deps['react-dom']) {
      if (deps['react-native']) return 'React Native'
      if (deps['expo']) return 'Expo'
      return 'React'
    }
    if (deps['vue']) {
      if (deps['quasar']) return 'Vue + Quasar'
      return 'Vue'
    }
    if (deps['@angular/core']) return 'Angular'
    if (deps['express'] && deps['react']) return 'Node.js + Express + React'
    if (deps['express']) return 'Node.js + Express'
    if (deps['@nestjs/core']) return 'NestJS'
    if (deps['koa']) return 'Node.js + Koa'
    if (deps['fastify']) return 'Node.js + Fastify'
    if (deps['hapi']) return 'Node.js + Hapi'
    if (deps['@hapi/hapi']) return 'Node.js + Hapi'
    if (deps['svelte']) return 'Svelte'
    if (deps['solid-js']) return 'SolidJS'

    return 'Node.js'
  }

  private detectByDirectory(structure: string[]): string {
    const names = structure
      .filter((s) => !s.includes('/'))
      .map((s) => s.replace('/', ''))

    if (names.includes('Cargo.toml')) return 'Rust'
    if (names.includes('go.mod')) return 'Go'
    if (names.some((n) => n.endsWith('.csproj'))) return '.NET / C#'
    if (names.some((n) => n.endsWith('.sln'))) return '.NET / C#'
    if (names.includes('mix.exs')) return 'Elixir'
    if (names.includes('rebar.config')) return 'Erlang'
    if (names.includes('Package.swift')) return 'Swift'
    return 'Generic'
  }

  // ============================================
  // 3. 目录结构扫描
  // ============================================

  private async scanDirectory(projectPath: string): Promise<string[]> {
    const structure: string[] = []
    const visited = new Set<string>()

    const scan = async (dir: string, depth: number) => {
      if (depth > 4) return

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          if (entry.name === 'node_modules') continue
          if (entry.name === 'vendor') continue  // Go/PHP vendor
          if (entry.name === 'target') continue  // Rust target
          if (entry.name === 'dist') continue
          if (entry.name === 'dist-electron') continue
          if (entry.name === 'build') continue
          if (entry.name === 'coverage') continue
          if (entry.name === '__pycache__') continue
          if (entry.name === '.venv') continue
          if (entry.name === 'venv') continue

          const fullPath = path.join(dir, entry.name)
          const relPath = path.relative(projectPath, fullPath)

          if (visited.has(relPath)) continue
          visited.add(relPath)

          if (entry.isDirectory()) {
            structure.push(relPath + '/')
            if (depth < 3) {
              await scan(fullPath, depth + 1)
            }
          } else {
            structure.push(relPath)
          }
        }
      } catch {
        // ignore permission errors
      }
    }

    await scan(projectPath, 0)
    return structure
  }

  // ============================================
  // 4. 关键文件内容分析
  // ============================================

  private async analyzeKeyFiles(projectPath: string, framework: string): Promise<FileAnalysis[]> {
    const analyses: FileAnalysis[] = []
    const keyFiles = this.identifyKeyFiles(framework)

    for (const relPath of this.structure) {
      if (relPath.endsWith('/')) continue

      const ext = path.extname(relPath)
      const basename = path.basename(relPath, ext)
      const lower = relPath.toLowerCase()

      // 判断文件用途
      let purpose: FileAnalysis['purpose'] = 'other'

      // 路由文件
      if (lower.includes('route') || lower.includes('router') ||
          basename === 'urls' || basename === 'endpoints') {
        purpose = 'route'
      }
      // 控制器
      else if (lower.includes('controller') || lower.includes('handler') ||
               lower.includes('resource')) {
        purpose = 'controller'
      }
      // 服务层
      else if (lower.includes('service') || lower.includes('usecase') ||
               lower.includes('use-case') || lower.includes('application')) {
        purpose = 'service'
      }
      // 模型/实体
      else if (lower.includes('model') || lower.includes('entity') ||
               lower.includes('schema') || lower.includes('dto') ||
               lower.includes('domain')) {
        purpose = 'model'
      }
      // 组件
      else if (lower.includes('component') || ext === '.tsx' || ext === '.jsx' || ext === '.vue') {
        if (lower.includes('page') || lower.includes('view') || lower.includes('screen')) {
          purpose = 'component'
        } else if (ext === '.tsx' || ext === '.jsx' || ext === '.vue') {
          purpose = 'component'
        }
      }
      // 配置
      else if (basename === 'config' || basename === 'configuration' ||
               ext === '.yaml' || ext === '.yml' || ext === '.toml') {
        purpose = 'config'
      }
      // 工具
      else if (lower.includes('util') || lower.includes('helper') || lower.includes('common')) {
        purpose = 'util'
      }

      // 只读取关键文件的内容
      if (keyFiles.includes(ext) || purpose !== 'other') {
        try {
          const content = await fs.readFile(path.join(projectPath, relPath), 'utf-8')
          if (content.length > 50000) continue  // 跳过超大文件
          analyses.push({
            filePath: relPath,
            content,
            language: this.getLanguage(ext),
            purpose,
          })
        } catch {
          // ignore read errors
        }
      }
    }

    return analyses
  }

  private identifyKeyFiles(framework: string): string[] {
    // 根据框架确定需要读取的文件扩展名
    const common = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.json', '.yaml', '.yml']

    if (framework.startsWith('Go')) return ['.go', '.mod']
    if (framework.startsWith('Rust')) return ['.rs', '.toml']
    if (framework.startsWith('Python')) return ['.py', '.toml']
    if (framework.startsWith('Java')) return ['.java', '.xml', '.gradle', '.properties']
    if (framework.startsWith('Ruby')) return ['.rb', '.erb', '.yml']
    if (framework.startsWith('PHP')) return ['.php', '.json']

    return common
  }

  private getLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'TypeScript', '.tsx': 'TypeScript/React',
      '.js': 'JavaScript', '.jsx': 'JavaScript/React',
      '.vue': 'Vue',
      '.py': 'Python',
      '.go': 'Go',
      '.rs': 'Rust',
      '.java': 'Java',
      '.rb': 'Ruby',
      '.php': 'PHP',
      '.cs': 'C#',
      '.swift': 'Swift',
      '.kt': 'Kotlin',
      '.scala': 'Scala',
      '.dart': 'Dart',
      '.cpp': 'C++', '.cc': 'C++', '.c': 'C',
      '.h': 'C/C++', '.hpp': 'C++',
    }
    return map[ext] ?? ext.replace('.', '').toUpperCase()
  }

  // ============================================
  // 5. 路由/API 提取
  // ============================================

  private extractRoutes(framework: string): RouteInfo[] {
    const routes: RouteInfo[] = []
    const routeFiles = this.fileAnalyses.filter((f) => f.purpose === 'route')

    for (const file of routeFiles) {
      const extracted = this.parseRoutes(file.content, framework, file.filePath)
      routes.push(...extracted)
    }

    // 也从控制器文件中提取
    const controllerFiles = this.fileAnalyses.filter((f) => f.purpose === 'controller')
    for (const file of controllerFiles) {
      const extracted = this.parseControllerRoutes(file.content, framework, file.filePath)
      routes.push(...extracted)
    }

    return routes
  }

  private parseRoutes(content: string, framework: string, filePath: string): RouteInfo[] {
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

  private parseControllerRoutes(content: string, framework: string, filePath: string): RouteInfo[] {
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

  // ============================================
  // 6. 实体/模型提取
  // ============================================

  private extractEntities(framework: string): EntityInfo[] {
    const entities: EntityInfo[] = []
    const modelFiles = this.fileAnalyses.filter((f) =>
      f.purpose === 'model' || f.purpose === 'entity'
    )

    for (const file of modelFiles) {
      const extracted = this.parseEntities(file.content, framework, file.filePath)
      entities.push(...extracted)
    }

    return entities
  }

  private parseEntities(content: string, framework: string, filePath: string): EntityInfo[] {
    const entities: EntityInfo[] = []

    if (framework.includes('TypeScript') || framework.includes('Node.js') || framework.includes('NestJS')) {
      // 类定义: class User { ... }
      const classRegex = /class\s+(\w+).*?\{/g
      let match
      while ((match = classRegex.exec(content)) !== null) {
        const className = match[1]
        const startIdx = match.index
        const endIdx = this.findClassEnd(content, startIdx)
        const classBody = content.slice(startIdx, endIdx)

        // 提取字段
        const fields: string[] = []
        const fieldRegex = /(?:private|public|protected|readonly)?\s*(\w+)\??\s*:\s*(\w+)/g
        let fieldMatch
        while ((fieldMatch = fieldRegex.exec(classBody)) !== null) {
          fields.push(`${fieldMatch[1]}: ${fieldMatch[2]}`)
        }

        if (fields.length > 0 || classBody.includes('@Entity') || classBody.includes('@Schema')) {
          entities.push({ name: className, fields: fields.slice(0, 10), file: filePath })
        }
      }
    }

    if (framework.includes('Python')) {
      // Python 类定义
      const classRegex = /class\s+(\w+)(?:\([^)]*\))?\s*:/g
      let match
      while ((match = classRegex.exec(content)) !== null) {
        const className = match[1]
        // 跳过测试类和非模型类
        if (className.startsWith('Test')) continue

        const fields: string[] = []
        const lines = content.slice(match.index, match.index + 2000).split('\n')
        for (const line of lines.slice(1)) {
          if (line.match(/^\s+\w+\s*=\s*(models\.|Column|Field)/)) {
            const fieldMatch = line.match(/(\w+)\s*=/)
            if (fieldMatch) fields.push(fieldMatch[1])
          }
          if (line.trim() === '' || line.match(/^\s*class\s/)) break
        }

        if (fields.length > 0) {
          entities.push({ name: className, fields: fields.slice(0, 10), file: filePath })
        }
      }
    }

    if (framework.includes('Go')) {
      // Go struct 定义
      const structRegex = /type\s+(\w+)\s+struct\s*\{/g
      let match
      while ((match = structRegex.exec(content)) !== null) {
        const structName = match[1]
        const fields: string[] = []
        const lines = content.slice(match.index, match.index + 2000).split('\n')
        for (const line of lines.slice(1)) {
          if (line.includes('}')) break
          const fieldMatch = line.match(/^\s+(\w+)\s+\w+/)
          if (fieldMatch) fields.push(fieldMatch[1])
        }
        entities.push({ name: structName, fields: fields.slice(0, 10), file: filePath })
      }
    }

    if (framework.includes('Java')) {
      // Java 类定义
      const classRegex = /(?:public\s+)?class\s+(\w+)/g
      let match
      while ((match = classRegex.exec(content)) !== null) {
        const className = match[1]
        if (className.endsWith('Test')) continue
        const fields: string[] = []
        const lines = content.slice(match.index, match.index + 3000).split('\n')
        for (const line of lines.slice(1)) {
          if (line.includes('class ') && !line.includes('@')) break
          const fieldMatch = line.match(/(?:private|public|protected)\s+\w+\s+(\w+)\s*[;=]/)
          if (fieldMatch) fields.push(fieldMatch[1])
        }
        if (fields.length > 0) {
          entities.push({ name: className, fields: fields.slice(0, 10), file: filePath })
        }
      }
    }

    return entities
  }

  private findClassEnd(content: string, startIndex: number): number {
    let depth = 0
    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') depth++
      if (content[i] === '}') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    return content.length
  }

  // ============================================
  // 7. 模块构建
  // ============================================

  private buildModules(
    projectName: string,
    framework: string,
    configs: Awaited<ReturnType<typeof this.readConfigs>>,
    routes: RouteInfo[],
    entities: EntityInfo[],
  ): ScanModule[] {
    const modules: ScanModule[] = []

    // 从 README 或 package.json 提取描述
    let projectDescription = ''
    const readmeFile = this.fileAnalyses.find((f) =>
      f.filePath.toLowerCase().includes('readme')
    )
    if (readmeFile) {
      const lines = readmeFile.content.split('\n')
        .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('```'))
      projectDescription = lines.slice(0, 3).join(' ').trim().substring(0, 200)
    }
    if (!projectDescription && configs.packageJson?.description) {
      projectDescription = configs.packageJson.description as string
    }

    // 策略1：基于 src/ 下的目录识别模块
    const srcDirs = this.getSourceDirectories()

    if (srcDirs.length > 0) {
      for (const dir of srcDirs) {
        const module = this.buildModuleFromDir(dir, framework, routes, entities)
        if (module) modules.push(module)
      }
    }

    // 策略2：如果没有 src/ 目录，基于路由分组
    if (modules.length === 0 && routes.length > 0) {
      const routeModules = this.groupRoutesByModule(routes, entities)
      modules.push(...routeModules)
    }

    // 策略3：基于实体分组
    if (modules.length === 0 && entities.length > 0) {
      const entityModules = this.groupEntitiesByModule(entities)
      modules.push(...entityModules)
    }

    // 策略4：兜底 - 从 scripts 或默认生成
    if (modules.length === 0) {
      const fallback = this.buildFallbackModule(projectName, framework, configs, projectDescription)
      modules.push(fallback)
    }

    return modules.slice(0, 8)  // 限制最大模块数
  }

  private getSourceDirectories(): Array<{ name: string; path: string; files: string[] }> {
    const srcPrefixes = ['src/', 'app/', 'lib/', 'internal/', 'pkg/', 'server/', 'api/', 'core/']
    const dirs = new Map<string, { name: string; path: string; files: string[] }>()

    for (const relPath of this.structure) {
      if (!relPath.endsWith('/')) continue

      const parts = relPath.split('/')
      // 寻找 src/xxx/ 或 app/xxx/ 这样的一级子目录
      if (parts.length === 2) {
        const parent = parts[0] + '/'
        if (srcPrefixes.includes(parent)) {
          const dirName = parts[0]
          const subName = parts[1]
          if (!dirs.has(subName)) {
            dirs.set(subName, {
              name: subName,
              path: relPath,
              files: [],
            })
          }
        }
      }

      // 收集每个目录下的文件
      for (const [dirName, dirInfo] of dirs) {
        if (relPath.startsWith(dirInfo.path) && !relPath.endsWith('/')) {
          dirInfo.files.push(relPath)
        }
      }
    }

    return Array.from(dirs.values())
      .filter((d) => d.files.length > 0)
      .sort((a, b) => b.files.length - a.files.length)
  }

  private buildModuleFromDir(
    dir: { name: string; path: string; files: string[] },
    framework: string,
    routes: RouteInfo[],
    entities: EntityInfo[],
  ): ScanModule | null {
    const dirMeaning = this.inferDirectoryMeaning(dir.name)
    const processes: ScanProcess[] = []

    // 过滤出该目录相关的路由和实体
    const dirRoutes = routes.filter((r) =>
      r.file?.includes(dir.path) ||
      r.path.toLowerCase().includes(dir.name.toLowerCase())
    )
    const dirEntities = entities.filter((e) =>
      e.file?.includes(dir.path) ||
      e.name.toLowerCase().includes(dir.name.toLowerCase())
    )

    // 分析目录下的文件类型
    const components = dir.files.filter((f) =>
      f.endsWith('.tsx') || f.endsWith('.jsx') || f.endsWith('.vue') ||
      f.endsWith('.svelte') || f.endsWith('.html')
    )
    const services = dir.files.filter((f) =>
      f.includes('service') || f.includes('api') || f.includes('controller') ||
      f.includes('usecase') || f.includes('handler')
    )
    const models = dir.files.filter((f) =>
      f.includes('model') || f.includes('entity') || f.includes('schema') ||
      f.includes('domain') || f.includes('dto')
    )
    const tests = dir.files.filter((f) =>
      f.includes('.test.') || f.includes('.spec.') || f.includes('_test.')
    )

    // 流程1：界面交互（如果有组件）
    if (components.length > 0) {
      const features: ScanFeature[] = components.slice(0, 5).map((f) => {
        const name = path.basename(f, path.extname(f))
        return {
          name,
          description: `${framework} 界面组件`,
          type: 'feature' as const,
        }
      })
      processes.push({
        name: `${dirMeaning}界面层`,
        description: `${components.length} 个界面组件/页面`,
        features,
      })
    }

    // 流程2：API/服务层（如果有路由或控制器）
    if (services.length > 0 || dirRoutes.length > 0) {
      const features: ScanFeature[] = []
      if (dirRoutes.length > 0) {
        features.push(...dirRoutes.slice(0, 5).map((r) => ({
          name: `${r.method ?? 'GET'} ${r.path}`,
          description: 'API 端点',
          type: 'feature' as const,
        })))
      }
      if (features.length === 0) {
        features.push(...services.slice(0, 3).map((f) => {
          const name = path.basename(f, path.extname(f))
          return {
            name,
            description: '业务服务',
            type: 'feature' as const,
          }
        }))
      }
      processes.push({
        name: `${dirMeaning}服务层`,
        description: `${services.length || dirRoutes.length} 个服务/API`,
        features,
      })
    }

    // 流程3：数据层（如果有模型/实体）
    if (models.length > 0 || dirEntities.length > 0) {
      const features: ScanFeature[] = []
      if (dirEntities.length > 0) {
        features.push(...dirEntities.slice(0, 5).map((e) => ({
          name: e.name,
          description: e.fields.length > 0
            ? `字段: ${e.fields.slice(0, 3).join(', ')}${e.fields.length > 3 ? '...' : ''}`
            : '数据实体',
          type: 'feature' as const,
        })))
      }
      if (features.length === 0) {
        features.push(...models.slice(0, 3).map((f) => {
          const name = path.basename(f, path.extname(f))
          return {
            name,
            description: '数据模型',
            type: 'feature' as const,
          }
        }))
      }
      processes.push({
        name: `${dirMeaning}数据层`,
        description: `${models.length || dirEntities.length} 个数据模型`,
        features,
      })
    }

    // 流程4：测试（如果有测试文件）
    if (tests.length > 0) {
      processes.push({
        name: `${dirMeaning}测试`,
        description: `${tests.length} 个测试文件`,
        features: tests.slice(0, 3).map((f) => {
          const name = path.basename(f, path.extname(f))
          return {
            name,
            description: '单元测试/集成测试',
            type: 'feature' as const,
          }
        }),
      })
    }

    // 如果没有识别到任何流程，创建一个通用流程
    if (processes.length === 0) {
      const otherFiles = dir.files.filter((f) =>
        !f.endsWith('.css') && !f.endsWith('.scss') && !f.endsWith('.less')
      )
      if (otherFiles.length > 0) {
        processes.push({
          name: `${dirMeaning}管理`,
          description: `${otherFiles.length} 个代码文件`,
          features: otherFiles.slice(0, 4).map((f) => {
            const name = path.basename(f, path.extname(f))
            return {
              name,
              description: `${path.extname(f)} 文件`,
              type: 'feature' as const,
            }
          }),
        })
      }
    }

    if (processes.length === 0) return null

    return {
      name: dirMeaning,
      description: `${dir.name} 模块 (${dir.files.length} 个文件)`,
      processes,
    }
  }

  private groupRoutesByModule(routes: RouteInfo[], entities: EntityInfo[]): ScanModule[] {
    // 根据路由路径前缀分组
    const groups = new Map<string, RouteInfo[]>()

    for (const route of routes) {
      const parts = route.path.split('/').filter(Boolean)
      const prefix = parts.length > 0 ? parts[0] : 'api'
      if (!groups.has(prefix)) groups.set(prefix, [])
      groups.get(prefix)!.push(route)
    }

    return Array.from(groups.entries()).slice(0, 6).map(([prefix, routes]) => {
      const meaning = this.inferDirectoryMeaning(prefix)
      const relatedEntities = entities.filter((e) =>
        e.name.toLowerCase().includes(prefix.toLowerCase()) ||
        prefix.toLowerCase().includes(e.name.toLowerCase())
      )

      return {
        name: meaning,
        description: `${prefix} API 模块 (${routes.length} 个端点)`,
        processes: [
          {
            name: `${meaning}接口层`,
            description: `${routes.length} 个 API 端点`,
            features: routes.slice(0, 5).map((r) => ({
              name: `${r.method ?? 'GET'} ${r.path}`,
              description: 'API 端点',
              type: 'feature' as const,
            })),
          },
          ...(relatedEntities.length > 0 ? [{
            name: `${meaning}数据层`,
            description: `${relatedEntities.length} 个数据实体`,
            features: relatedEntities.slice(0, 5).map((e) => ({
              name: e.name,
              description: e.fields.length > 0
                ? `字段: ${e.fields.slice(0, 3).join(', ')}`
                : '数据实体',
              type: 'feature' as const,
            })),
          }] : []),
        ],
      }
    })
  }

  private groupEntitiesByModule(entities: EntityInfo[]): ScanModule[] {
    // 简单按实体名首字母分组（前6组）
    const groups = new Map<string, EntityInfo[]>()

    for (const entity of entities) {
      // 尝试从文件名推断模块
      const fileParts = entity.file?.split('/') ?? []
      const moduleHint = fileParts.find((p) =>
        p !== 'src' && p !== 'app' && p !== 'models' && p !== 'entities' && p !== ''
      )
      const group = moduleHint ?? entity.name[0].toUpperCase()
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group)!.push(entity)
    }

    return Array.from(groups.entries()).slice(0, 6).map(([group, ents]) => ({
      name: this.inferDirectoryMeaning(group),
      description: `${group} 领域 (${ents.length} 个实体)`,
      processes: [
        {
          name: `${this.inferDirectoryMeaning(group)}数据模型`,
          description: `${ents.length} 个数据实体`,
          features: ents.slice(0, 5).map((e) => ({
            name: e.name,
            description: e.fields.length > 0
              ? `字段: ${e.fields.slice(0, 3).join(', ')}`
              : '数据实体',
            type: 'feature' as const,
          })),
        },
      ],
    }))
  }

  private buildFallbackModule(
    projectName: string,
    framework: string,
    configs: Awaited<ReturnType<typeof this.readConfigs>>,
    description: string,
  ): ScanModule {
    const processes: ScanProcess[] = []

    // 从 scripts 生成
    if (configs.packageJson?.scripts) {
      const scripts = configs.packageJson.scripts as Record<string, string>
      const devScripts = Object.entries(scripts).filter(([k]) =>
        k.includes('dev') || k.includes('start') || k.includes('build') ||
        k.includes('test') || k.includes('lint')
      )
      if (devScripts.length > 0) {
        processes.push({
          name: '开发运维',
          description: `${devScripts.length} 个开发脚本`,
          features: devScripts.slice(0, 5).map(([name, cmd]) => ({
            name,
            description: cmd,
            type: 'feature' as const,
          })),
        })
      }
    }

    // 从依赖生成
    const allDeps = [
      ...Object.keys((configs.packageJson?.dependencies as Record<string, string>) ?? {}),
      ...Object.keys((configs.packageJson?.devDependencies as Record<string, string>) ?? {}),
    ]
    if (allDeps.length > 0) {
      const keyDeps = allDeps
        .filter((d) => !d.startsWith('@types/') && !d.includes('eslint') && !d.includes('prettier'))
        .slice(0, 5)
      if (keyDeps.length > 0) {
        processes.push({
          name: '技术栈',
          description: `${allDeps.length} 个依赖包`,
          features: keyDeps.map((d) => ({
            name: d,
            description: '项目依赖',
            type: 'feature' as const,
          })),
        })
      }
    }

    // 默认兜底
    if (processes.length === 0) {
      processes.push({
        name: '核心业务',
        description: `${framework} 项目`,
        features: [
          {
            name: '功能实现',
            description: description || '待补充具体功能描述',
            type: 'feature' as const,
          },
        ],
      })
    }

    return {
      name: projectName,
      description: description || `${framework} 项目`,
      processes,
    }
  }

  // ============================================
  // 辅助方法
  // ============================================

  private inferDirectoryMeaning(dirName: string): string {
    const mapping: Record<string, string> = {
      user: '用户管理',
      users: '用户管理',
      auth: '认证授权',
      authentication: '认证授权',
      login: '登录认证',
      product: '商品管理',
      products: '商品管理',
      item: '商品管理',
      items: '商品管理',
      order: '订单管理',
      orders: '订单管理',
      payment: '支付管理',
      pay: '支付管理',
      billing: '账单管理',
      invoice: '发票管理',
      cart: '购物车',
      shop: '商城',
      store: '存储管理',
      storage: '存储管理',
      inventory: '库存管理',
      warehouse: '仓库管理',
      logistics: '物流管理',
      shipping: '物流配送',
      delivery: '配送管理',
      message: '消息中心',
      messages: '消息中心',
      notification: '通知管理',
      search: '搜索服务',
      elasticsearch: '搜索服务',
      report: '报表统计',
      analytics: '数据分析',
      metrics: '指标监控',
      monitoring: '监控告警',
      admin: '后台管理',
      dashboard: '数据看板',
      settings: '系统设置',
      config: '配置管理',
      configuration: '配置中心',
      common: '公共组件',
      shared: '公共模块',
      utils: '工具方法',
      utility: '工具方法',
      helpers: '辅助函数',
      api: 'API接口',
      rest: 'REST接口',
      graphql: 'GraphQL',
      service: '业务服务',
      services: '业务服务',
      component: '组件库',
      components: '组件库',
      ui: 'UI组件',
      page: '页面',
      pages: '页面',
      view: '视图',
      views: '视图',
      screen: '页面',
      screens: '页面',
      router: '路由',
      routes: '路由',
      routing: '路由',
      navigation: '导航',
      model: '数据模型',
      models: '数据模型',
      entity: '实体',
      entities: '实体',
      domain: '领域模型',
      dto: '数据传输',
      middleware: '中间件',
      interceptor: '拦截器',
      guard: '守卫',
      hook: 'Hook',
      hooks: 'Hooks',
      composable: '组合式函数',
      composables: '组合式函数',
      test: '测试',
      tests: '测试',
      spec: '测试',
      specs: '测试',
      e2e: '端到端测试',
      unit: '单元测试',
      integration: '集成测试',
      assets: '静态资源',
      static: '静态资源',
      public: '公共资源',
      styles: '样式',
      style: '样式',
      css: '样式',
      scss: '样式',
      types: '类型定义',
      type: '类型定义',
      interface: '接口定义',
      interfaces: '接口定义',
      i18n: '国际化',
      locale: '国际化',
      lang: '多语言',
      translation: '翻译',
      docs: '文档',
      documentation: '文档',
      readme: '说明文档',
      guide: '指南',
      examples: '示例',
      demo: '演示',
      cli: '命令行',
      cmd: '命令',
      command: '命令',
      worker: '工作进程',
      workers: '工作进程',
      queue: '队列',
      job: '任务',
      jobs: '任务',
      scheduler: '调度器',
      cron: '定时任务',
      cache: '缓存',
      redis: 'Redis',
      database: '数据库',
      db: '数据库',
      migration: '数据库迁移',
      migrations: '数据库迁移',
      seed: '数据种子',
      seeds: '数据种子',
      websocket: 'WebSocket',
      ws: 'WebSocket',
      socket: 'Socket',
      realtime: '实时通信',
      push: '推送服务',
      email: '邮件服务',
      sms: '短信服务',
      file: '文件管理',
      files: '文件管理',
      upload: '文件上传',
      download: '文件下载',
      media: '媒体处理',
      image: '图片处理',
      video: '视频处理',
      audio: '音频处理',
      parser: '解析器',
      generator: '生成器',
      builder: '构建器',
      compiler: '编译器',
      transformer: '转换器',
      plugin: '插件',
      plugins: '插件',
      extension: '扩展',
      extensions: '扩展',
      adapter: '适配器',
      adapters: '适配器',
      connector: '连接器',
      client: '客户端',
      server: '服务端',
      core: '核心模块',
      base: '基础模块',
      foundation: '基础框架',
      framework: '框架',
      engine: '引擎',
      runtime: '运行时',
      platform: '平台',
      sdk: 'SDK',
      toolkit: '工具箱',
      library: '库',
      lib: '库',
      pkg: '包',
      package: '包',
      module: '模块',
      modules: '模块',
      feature: '功能',
      features: '功能',
      main: '主入口',
      entry: '入口',
      index: '索引',
      app: '应用',
      application: '应用',
      web: 'Web应用',
      mobile: '移动端',
      desktop: '桌面端',
      backend: '后端',
      frontend: '前端',
      serverless: '无服务',
      lambda: '函数计算',
      edge: '边缘计算',
      proxy: '代理',
      gateway: '网关',
      loadbalancer: '负载均衡',
      health: '健康检查',
      probe: '探针',
      trace: '链路追踪',
      logging: '日志',
      logger: '日志',
      audit: '审计',
      security: '安全',
      crypto: '加密',
      encrypt: '加密',
      decrypt: '解密',
      hash: '哈希',
      jwt: 'JWT认证',
      oauth: 'OAuth认证',
      sso: '单点登录',
      rbac: '权限控制',
      permission: '权限',
      role: '角色',
      policy: '策略',
      rule: '规则',
      constraint: '约束',
      validator: '校验器',
      validation: '验证',
      schema: '模式',
      serializer: '序列化',
      deserializer: '反序列化',
      encoder: '编码',
      decoder: '解码',
      formatter: '格式化',
      lexer: '词法分析',
      ast: '语法树',
      bundler: '打包',
      build: '构建',
      deploy: '部署',
      ci: '持续集成',
      cd: '持续部署',
      devops: '运维',
      infrastructure: '基础设施',
      terraform: '基础设施',
      ansible: '自动化',
      docker: '容器',
      k8s: 'Kubernetes',
      kubernetes: 'Kubernetes',
      helm: 'Helm',
      chart: '图表',
      manifest: '清单',
      configmap: '配置映射',
      secret: '密钥',
      ingress: '入口',
      deployment: '部署',
      pod: '容器组',
      namespace: '命名空间',
      cluster: '集群',
      node: '节点',
      volume: '存储卷',
      network: '网络',
      firewall: '防火墙',
      cdn: 'CDN',
      dns: '域名解析',
      ssl: 'SSL证书',
      tls: 'TLS',
      http: 'HTTP',
      https: 'HTTPS',
      grpc: 'gRPC',
      thrift: 'Thrift',
      soap: 'SOAP',
      xmlrpc: 'XML-RPC',
      jsonrpc: 'JSON-RPC',
      sse: 'SSE',
      mqtt: 'MQTT',
      amqp: 'AMQP',
      kafka: 'Kafka',
      rabbitmq: 'RabbitMQ',
      nats: 'NATS',
      pulsar: 'Pulsar',
      zeromq: 'ZeroMQ',
      memcached: 'Memcached',
      mongodb: 'MongoDB',
      postgres: 'PostgreSQL',
      mysql: 'MySQL',
      sqlite: 'SQLite',
      mssql: 'SQL Server',
      oracle: 'Oracle',
      cassandra: 'Cassandra',
      solr: 'Solr',
      meilisearch: 'Meilisearch',
      typesense: 'Typesense',
      algolia: 'Algolia',
      opensearch: 'OpenSearch',
      s3: '对象存储',
      minio: 'MinIO',
      oss: '对象存储',
      cos: '对象存储',
      bos: '对象存储',
      obs: '对象存储',
      wasabi: 'Wasabi',
      backblaze: 'Backblaze',
      dropbox: 'Dropbox',
      drive: '云盘',
      onedrive: 'OneDrive',
      gdrive: 'Google Drive',
      box: 'Box',
      ftp: 'FTP',
      sftp: 'SFTP',
      scp: 'SCP',
      rsync: 'Rsync',
      webhook: 'WebHook',
      callback: '回调',
      event: '事件',
      eventbus: '事件总线',
      pubsub: '发布订阅',
      observer: '观察者',
      listener: '监听器',
      handler: '处理器',
      consumer: '消费者',
      producer: '生产者',
      subscriber: '订阅者',
      publisher: '发布者',
      actor: 'Actor',
      saga: 'Saga',
      cqrs: 'CQRS',
      ddd: '领域驱动',
      hexagonal: '六边形架构',
      clean: '整洁架构',
      onion: '洋葱架构',
      layered: '分层架构',
      mvc: 'MVC',
      mvvm: 'MVVM',
      mvp: 'MVP',
      flux: 'Flux',
      redux: 'Redux',
      mobx: 'MobX',
      zustand: 'Zustand',
      recoil: 'Recoil',
      jotai: 'Jotai',
      pinia: 'Pinia',
      vuex: 'Vuex',
      context: 'Context',
      provider: 'Provider',
      hoc: 'HOC',
      render: '渲染',
      hydration: '水合',
      ssr: 'SSR',
      csr: 'CSR',
      ssg: 'SSG',
      isr: 'ISR',
      spa: 'SPA',
      pwa: 'PWA',
      amp: 'AMP',
      storybook: 'Storybook',
      design: '设计',
      theme: '主题',
      palette: '调色板',
      icon: '图标',
      font: '字体',
      typography: '排版',
      layout: '布局',
      grid: '网格',
      flex: '弹性布局',
      responsive: '响应式',
      animation: '动画',
      transition: '过渡',
      motion: '动效',
      gesture: '手势',
      drag: '拖拽',
      drop: '拖放',
      sortable: '排序',
      resizable: '调整大小',
      scroll: '滚动',
      virtual: '虚拟列表',
      infinite: '无限滚动',
      pagination: '分页',
      carousel: '轮播',
      slider: '滑块',
      tabs: '标签页',
      accordion: '手风琴',
      modal: '弹窗',
      dialog: '对话框',
      drawer: '抽屉',
      tooltip: '提示',
      popover: '弹出框',
      menu: '菜单',
      dropdown: '下拉菜单',
      select: '选择器',
      autocomplete: '自动完成',
      combobox: '组合框',
      multiselect: '多选',
      checkbox: '复选框',
      radio: '单选框',
      switch: '开关',
      toggle: '切换',
      button: '按钮',
      input: '输入框',
      textarea: '文本域',
      editor: '编辑器',
      markdown: 'Markdown',
      rich: '富文本',
      wysiwyg: '所见即所得',
      code: '代码',
      json: 'JSON',
      yaml: 'YAML',
      xml: 'XML',
      csv: 'CSV',
      excel: 'Excel',
      pdf: 'PDF',
      doc: 'Word',
      ppt: 'PPT',
      gallery: '图库',
      album: '相册',
      avatar: '头像',
      banner: '横幅',
      cover: '封面',
      thumbnail: '缩略图',
      watermark: '水印',
      crop: '裁剪',
      resize: '缩放',
      compress: '压缩',
      convert: '转换',
      filter: '滤镜',
      effect: '特效',
      sticker: '贴纸',
      emoji: '表情',
      reaction: '反应',
      comment: '评论',
      review: '评价',
      rating: '评分',
      like: '点赞',
      favorite: '收藏',
      bookmark: '书签',
      tag: '标签',
      category: '分类',
      label: '标签',
      group: '分组',
      team: '团队',
      organization: '组织',
      department: '部门',
      project: '项目',
      task: '任务',
      todo: '待办',
      issue: '问题',
      ticket: '工单',
      backlog: '待办列表',
      sprint: '冲刺',
      milestone: '里程碑',
      release: '发布',
      version: '版本',
      changelog: '更新日志',
      roadmap: '路线图',
      wiki: 'Wiki',
      knowledge: '知识库',
      faq: 'FAQ',
      help: '帮助',
      support: '支持',
      contact: '联系',
      feedback: '反馈',
      survey: '问卷',
      form: '表单',
      poll: '投票',
      quiz: '测验',
      exam: '考试',
      certificate: '证书',
      badge: '徽章',
      achievement: '成就',
      leaderboard: '排行榜',
      ranking: '排名',
      score: '分数',
      point: '积分',
      credit: '信用',
      coin: '代币',
      token: '令牌',
      voucher: '优惠券',
      coupon: '优惠券',
      discount: '折扣',
      promotion: '促销',
      campaign: '活动',
      activity: '活动',
      lottery: '抽奖',
      raffle: '抽奖',
      game: '游戏',
      tournament: '锦标赛',
      match: '比赛',
      competition: '竞赛',
      challenge: '挑战',
      quest: '任务',
      adventure: '冒险',
      story: '故事',
      chapter: '章节',
      episode: '剧集',
      season: '季',
      series: '系列',
      collection: '合集',
      playlist: '播放列表',
      history: '历史',
      timeline: '时间线',
      calendar: '日历',
      schedule: '日程',
      agenda: '议程',
      plan: '计划',
      goal: '目标',
      objective: '目标',
      kpi: 'KPI',
      metric: '指标',
      benchmark: '基准',
      baseline: '基线',
      threshold: '阈值',
      limit: '限制',
      quota: '配额',
      capacity: '容量',
      resource: '资源',
      pool: '资源池',
      allocator: '分配器',
      orchestrator: '编排器',
      coordinator: '协调器',
      broker: '代理',
      mediator: '中介',
      delegate: '委托',
      facade: '外观',
      wrapper: '包装器',
      bridge: '桥接',
      decorator: '装饰器',
      factory: '工厂',
      prototype: '原型',
      singleton: '单例',
      flyweight: '享元',
      strategy: '策略',
      iterator: '迭代器',
      memento: '备忘录',
      state: '状态',
      template: '模板方法',
      visitor: '访问者',
      chain: '责任链',
    }

    const lower = dirName.toLowerCase()
    return mapping[lower] ?? dirName
  }

  private parseToml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    let currentSection = ''

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        currentSection = trimmed.slice(1, -1)
        result[currentSection] = {}
        continue
      }
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim()
        let value = trimmed.slice(eqIdx + 1).trim()
        // 去除引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        if (currentSection) {
          (result[currentSection] as Record<string, unknown>)[key] = value
        } else {
          result[key] = value
        }
      }
    }

    return result
  }
}
