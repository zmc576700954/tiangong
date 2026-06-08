import { describe, it, expect } from 'vitest'
import { detectFramework } from '../project-scanner/framework-detector'
import { parseToml } from '../project-scanner/config-reader'
import type { ProjectConfigs } from '../project-scanner/config-reader'

function emptyConfigs(): ProjectConfigs {
  return {
    packageJson: null, goMod: null, cargoToml: null,
    pyprojectToml: null, requirementsTxt: null, pomXml: null,
    gradleBuild: null, gemfile: null, composerJson: null,
  }
}

// ==================== detectFramework ====================
describe('detectFramework', () => {
  describe('Go 项目', () => {
    it('Gin', () => {
      const configs = { ...emptyConfigs(), goMod: 'require github.com/gin-gonic/gin v1.9.0' }
      expect(detectFramework(configs, '/p')).toBe('Go + Gin')
    })

    it('Echo', () => {
      const configs = { ...emptyConfigs(), goMod: 'github.com/labstack/echo v4' }
      expect(detectFramework(configs, '/p')).toBe('Go + Echo')
    })

    it('Fiber', () => {
      const configs = { ...emptyConfigs(), goMod: 'github.com/gofiber/fiber/v2' }
      expect(detectFramework(configs, '/p')).toBe('Go + Fiber')
    })

    it('gRPC', () => {
      const configs = { ...emptyConfigs(), goMod: 'google.golang.org/grpc v1.50' }
      expect(detectFramework(configs, '/p')).toBe('Go + gRPC')
    })

    it('无已知框架 → Go', () => {
      const configs = { ...emptyConfigs(), goMod: 'module myproject' }
      expect(detectFramework(configs, '/p')).toBe('Go')
    })
  })

  describe('Rust 项目', () => {
    it('Actix Web', () => {
      const configs = { ...emptyConfigs(), cargoToml: { dependencies: { actix_web: '4.0' } } }
      expect(detectFramework(configs, '/p')).toBe('Rust + Actix Web')
    })

    it('Axum', () => {
      const configs = { ...emptyConfigs(), cargoToml: { dependencies: { axum: '0.7' } } }
      expect(detectFramework(configs, '/p')).toBe('Rust + Axum')
    })

    it('Rocket', () => {
      const configs = { ...emptyConfigs(), cargoToml: { dependencies: { rocket: '0.5' } } }
      expect(detectFramework(configs, '/p')).toBe('Rust + Rocket')
    })

    it('dev-dependencies 也被检测', () => {
      const configs = { ...emptyConfigs(), cargoToml: { 'dev-dependencies': { actix_web: '4.0' } } }
      expect(detectFramework(configs, '/p')).toBe('Rust + Actix Web')
    })

    it('无已知框架 → Rust', () => {
      const configs = { ...emptyConfigs(), cargoToml: { dependencies: { serde: '1.0' } } }
      expect(detectFramework(configs, '/p')).toBe('Rust')
    })
  })

  describe('Python 项目', () => {
    it('FastAPI (pyproject)', () => {
      const configs = { ...emptyConfigs(), pyprojectToml: { project: { dependencies: ['fastapi'] } } }
      expect(detectFramework(configs, '/p')).toBe('Python + FastAPI')
    })

    it('Django (requirements)', () => {
      const configs = { ...emptyConfigs(), requirementsTxt: 'django==4.2\npsycopg2==2.9' }
      expect(detectFramework(configs, '/p')).toBe('Python + Django')
    })

    it('Flask', () => {
      const configs = { ...emptyConfigs(), requirementsTxt: 'flask==2.3' }
      expect(detectFramework(configs, '/p')).toBe('Python + Flask')
    })

    it('无已知框架 → Python', () => {
      const configs = { ...emptyConfigs(), requirementsTxt: 'requests==2.31' }
      expect(detectFramework(configs, '/p')).toBe('Python')
    })
  })

  describe('Java 项目', () => {
    it('Spring Boot (pom)', () => {
      const configs = { ...emptyConfigs(), pomXml: '<dependency>spring-boot-starter-web</dependency>' }
      expect(detectFramework(configs, '/p')).toBe('Java + Spring Boot')
    })

    it('Spring (gradle)', () => {
      const configs = { ...emptyConfigs(), gradleBuild: "implementation 'org.springframework:spring-web'" }
      expect(detectFramework(configs, '/p')).toBe('Java + Spring')
    })

    it('Quarkus', () => {
      const configs = { ...emptyConfigs(), pomXml: '<artifactId>quarkus-resteasy</artifactId>' }
      expect(detectFramework(configs, '/p')).toBe('Java + Quarkus')
    })
  })

  describe('Ruby 项目', () => {
    it('Rails', () => {
      const configs = { ...emptyConfigs(), gemfile: "gem 'rails', '~> 7.0'" }
      expect(detectFramework(configs, '/p')).toBe('Ruby on Rails')
    })

    it('Sinatra', () => {
      const configs = { ...emptyConfigs(), gemfile: "gem 'sinatra'" }
      expect(detectFramework(configs, '/p')).toBe('Ruby + Sinatra')
    })
  })

  describe('PHP 项目', () => {
    it('Laravel', () => {
      const configs = { ...emptyConfigs(), composerJson: { require: { 'laravel/framework': '^10.0' } } }
      expect(detectFramework(configs, '/p')).toBe('PHP + Laravel')
    })

    it('Symfony', () => {
      const configs = { ...emptyConfigs(), composerJson: { require: { 'symfony/framework-bundle': '6.*' } } }
      expect(detectFramework(configs, '/p')).toBe('PHP + Symfony')
    })
  })

  describe('Node.js 项目', () => {
    it('Next.js', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { next: '^14.0' } } }
      expect(detectFramework(configs, '/p')).toBe('Next.js')
    })

    it('Electron + React', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { electron: '^28', react: '^18' } } }
      expect(detectFramework(configs, '/p')).toBe('Electron + React')
    })

    it('React', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { react: '^18', 'react-dom': '^18' } } }
      expect(detectFramework(configs, '/p')).toBe('React')
    })

    it('Vue', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { vue: '^3' } } }
      expect(detectFramework(configs, '/p')).toBe('Vue')
    })

    it('Angular', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { '@angular/core': '^17' } } }
      expect(detectFramework(configs, '/p')).toBe('Angular')
    })

    it('Express', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { express: '^4' } } }
      expect(detectFramework(configs, '/p')).toBe('Node.js + Express')
    })

    it('NestJS', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { '@nestjs/core': '^10' } } }
      expect(detectFramework(configs, '/p')).toBe('NestJS')
    })

    it('Svelte', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { svelte: '^4' } } }
      expect(detectFramework(configs, '/p')).toBe('Svelte')
    })

    it('devDependencies 也被检测', () => {
      const configs = { ...emptyConfigs(), packageJson: { devDependencies: { next: '^14' } } }
      expect(detectFramework(configs, '/p')).toBe('Next.js')
    })

    it('无已知框架 → Node.js', () => {
      const configs = { ...emptyConfigs(), packageJson: { dependencies: { lodash: '^4' } } }
      expect(detectFramework(configs, '/p')).toBe('Node.js')
    })
  })

  describe('优先级', () => {
    it('goMod 优先于 packageJson', () => {
      const configs = { ...emptyConfigs(), goMod: 'github.com/gin-gonic/gin v1.9', packageJson: { dependencies: { next: '^14' } } }
      expect(detectFramework(configs, '/p')).toBe('Go + Gin')
    })
  })

  describe('无配置 → Generic', () => {
    it('完全无配置', () => {
      expect(detectFramework(emptyConfigs(), '/p')).toBe('Generic')
    })
  })
})

// ==================== parseToml ====================
describe('parseToml', () => {
  it('基本 key-value', () => {
    const result = parseToml('name = "test"\nversion = "1.0"')
    expect(result.name).toBe('test')
    expect(result.version).toBe('1.0')
  })

  it('section 支持', () => {
    const result = parseToml('[package]\nname = "myapp"\nversion = "0.1"')
    expect(result.package).toEqual({ name: 'myapp', version: '0.1' })
  })

  it('数字解析', () => {
    const result = parseToml('port = 8080\nratio = 3.14')
    expect(result.port).toBe(8080)
    expect(result.ratio).toBe(3.14)
  })

  it('布尔值解析', () => {
    const result = parseToml('debug = true\nproduction = false')
    expect(result.debug).toBe(true)
    expect(result.production).toBe(false)
  })

  it('数组解析', () => {
    const result = parseToml('tags = ["web", "api", "rest"]')
    expect(result.tags).toEqual(['web', 'api', 'rest'])
  })

  it('注释跳过', () => {
    const result = parseToml('# comment\nname = "test"\n# another comment')
    expect(result.name).toBe('test')
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('空行跳过', () => {
    const result = parseToml('\n\nname = "test"\n\n')
    expect(result.name).toBe('test')
  })

  it('多行字符串 """..."""', () => {
    const toml = 'desc = """\nline1\nline2\nline3\n"""'
    const result = parseToml(toml)
    expect(result.desc).toContain('line1')
    expect(result.desc).toContain('line2')
  })

  it('单行多行字符串', () => {
    const result = parseToml('desc = """hello world"""')
    expect(result.desc).toBe('hello world')
  })

  it('单引号字符串', () => {
    const result = parseToml("name = 'test'")
    expect(result.name).toBe('test')
  })

  it('section 中的值', () => {
    const toml = '[dependencies]\nserde = "1.0"\ntokio = "1.0"'
    const result = parseToml(toml)
    expect(result.dependencies).toEqual({ serde: '1.0', tokio: '1.0' })
  })

  it('负数', () => {
    const result = parseToml('offset = -10')
    expect(result.offset).toBe(-10)
  })
})
