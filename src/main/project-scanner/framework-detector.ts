/**
 * 框架检测模块
 */

import type { ProjectConfigs } from './config-reader'

export function detectFramework(configs: ProjectConfigs, _projectPath: string): string {
  // Go 项目
  if (configs.goMod) return detectGoFramework(configs.goMod)

  // Rust 项目
  if (configs.cargoToml) return detectRustFramework(configs.cargoToml)

  // Python 项目
  if (configs.pyprojectToml || configs.requirementsTxt) {
    return detectPythonFramework(configs.pyprojectToml, configs.requirementsTxt)
  }

  // Java 项目
  if (configs.pomXml || configs.gradleBuild) {
    return detectJavaFramework(configs.pomXml, configs.gradleBuild)
  }

  // Ruby 项目
  if (configs.gemfile) return detectRubyFramework(configs.gemfile)

  // PHP 项目
  if (configs.composerJson) return detectPhpFramework(configs.composerJson)

  // Node.js 项目
  if (configs.packageJson) return detectNodeFramework(configs.packageJson)

  // 根据目录特征推断
  return detectByDirectory(configs)
}

function detectGoFramework(goMod: string): string {
  if (goMod.includes('github.com/gin-gonic/gin')) return 'Go + Gin'
  if (goMod.includes('github.com/labstack/echo')) return 'Go + Echo'
  if (goMod.includes('github.com/gofiber/fiber')) return 'Go + Fiber'
  if (goMod.includes('github.com/gorilla/mux')) return 'Go + Gorilla Mux'
  if (goMod.includes('github.com/go-kratos/kratos')) return 'Go + Kratos'
  if (goMod.includes('google.golang.org/grpc')) return 'Go + gRPC'
  return 'Go'
}

function detectRustFramework(cargoToml: Record<string, unknown>): string {
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

function detectPythonFramework(
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

function detectJavaFramework(pomXml: string | null, gradle: string | null): string {
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

function detectRubyFramework(gemfile: string): string {
  if (gemfile.includes('rails')) return 'Ruby on Rails'
  if (gemfile.includes('sinatra')) return 'Ruby + Sinatra'
  if (gemfile.includes('hanami')) return 'Ruby + Hanami'
  if (gemfile.includes('grape')) return 'Ruby + Grape'
  if (gemfile.includes('roda')) return 'Ruby + Roda'
  return 'Ruby'
}

function detectPhpFramework(composer: Record<string, unknown>): string {
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

function detectNodeFramework(pkg: Record<string, unknown>): string {
  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  }

  if (deps['next']) return 'Next.js'
  if (deps['nuxt']) return 'Nuxt.js'
  if (deps['remix'] || deps['@remix-run/react']) return 'Remix'
  if (deps['sveltekit'] || deps['@sveltejs/kit']) return 'SvelteKit'
  if (deps['astro']) return 'Astro'
  if (deps['electron']) {
    if (deps['vue']) return 'Electron + Vue'
    if (deps['@angular/core']) return 'Electron + Angular'
    if (deps['svelte']) return 'Electron + Svelte'
    if (deps['react']) return 'Electron + React'
    return 'Electron'
  }
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

function detectByDirectory(configs: ProjectConfigs): string {
  // 通过配置文件的存在性推断语言框架
  if (configs.cargoToml) return 'Rust'
  if (configs.goMod) return 'Go'
  if (configs.gemfile) return 'Ruby'
  if (configs.composerJson) return 'PHP'
  if (configs.pyprojectToml || configs.requirementsTxt) return 'Python'
  if (configs.pomXml || configs.gradleBuild) return 'Java'
  return 'Generic'
}
