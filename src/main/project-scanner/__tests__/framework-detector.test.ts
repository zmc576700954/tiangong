import { describe, it, expect } from 'vitest'
import { detectFramework } from '../framework-detector'
import type { ProjectConfigs } from '../config-reader'

function makeConfigs(overrides?: Partial<ProjectConfigs>): ProjectConfigs {
  return {
    packageJson: null,
    goMod: null,
    cargoToml: null,
    pyprojectToml: null,
    requirementsTxt: null,
    pomXml: null,
    gradleBuild: null,
    gemfile: null,
    composerJson: null,
    ...overrides,
  }
}

describe('detectFramework', () => {
  // ─── Go ───
  it('detects Go + Gin', () => {
    expect(detectFramework(makeConfigs({ goMod: 'require github.com/gin-gonic/gin v1.9.0' }), '')).toBe('Go + Gin')
  })

  it('detects Go + Echo', () => {
    expect(detectFramework(makeConfigs({ goMod: 'require github.com/labstack/echo v4.0.0' }), '')).toBe('Go + Echo')
  })

  it('detects Go + Fiber', () => {
    expect(detectFramework(makeConfigs({ goMod: 'require github.com/gofiber/fiber v2.0.0' }), '')).toBe('Go + Fiber')
  })

  it('detects plain Go', () => {
    expect(detectFramework(makeConfigs({ goMod: 'module myproject' }), '')).toBe('Go')
  })

  // ─── Rust ───
  it('detects Rust + Actix Web', () => {
    expect(detectFramework(makeConfigs({ cargoToml: { dependencies: { actix_web: '4.0' } } }), '')).toBe('Rust + Actix Web')
  })

  it('detects Rust + Axum', () => {
    expect(detectFramework(makeConfigs({ cargoToml: { dependencies: { axum: '0.6' } } }), '')).toBe('Rust + Axum')
  })

  it('detects Rust + Rocket', () => {
    expect(detectFramework(makeConfigs({ cargoToml: { dependencies: { rocket: '0.5' } } }), '')).toBe('Rust + Rocket')
  })

  it('detects plain Rust', () => {
    expect(detectFramework(makeConfigs({ cargoToml: { dependencies: {} } }), '')).toBe('Rust')
  })

  // ─── Python ───
  it('detects Python + FastAPI', () => {
    expect(detectFramework(makeConfigs({ requirementsTxt: 'fastapi==0.95.0' }), '')).toBe('Python + FastAPI')
  })

  it('detects Python + Flask', () => {
    expect(detectFramework(makeConfigs({ pyprojectToml: { dependencies: ['flask'] } }), '')).toBe('Python + Flask')
  })

  it('detects Python + Django', () => {
    expect(detectFramework(makeConfigs({ requirementsTxt: 'django==4.2' }), '')).toBe('Python + Django')
  })

  it('detects plain Python', () => {
    expect(detectFramework(makeConfigs({ requirementsTxt: 'requests==2.28.0' }), '')).toBe('Python')
  })

  // ─── Java ───
  it('detects Java + Spring Boot', () => {
    expect(detectFramework(makeConfigs({ pomXml: '<artifactId>spring-boot-starter</artifactId>' }), '')).toBe('Java + Spring Boot')
  })

  it('detects Java + Quarkus', () => {
    expect(detectFramework(makeConfigs({ gradleBuild: 'implementation io.quarkus:quarkus-core' }), '')).toBe('Java + Quarkus')
  })

  it('detects plain Java', () => {
    expect(detectFramework(makeConfigs({ pomXml: '<artifactId>my-app</artifactId>' }), '')).toBe('Java')
  })

  // ─── Ruby ───
  it('detects Ruby on Rails', () => {
    expect(detectFramework(makeConfigs({ gemfile: "gem 'rails', '~> 7.0'" }), '')).toBe('Ruby on Rails')
  })

  it('detects Ruby + Sinatra', () => {
    expect(detectFramework(makeConfigs({ gemfile: "gem 'sinatra'" }), '')).toBe('Ruby + Sinatra')
  })

  it('detects plain Ruby', () => {
    expect(detectFramework(makeConfigs({ gemfile: "gem 'rake'" }), '')).toBe('Ruby')
  })

  // ─── PHP ───
  it('detects PHP + Laravel', () => {
    expect(detectFramework(makeConfigs({ composerJson: { require: { 'laravel/framework': '^10.0' } } }), '')).toBe('PHP + Laravel')
  })

  it('detects PHP + Symfony', () => {
    expect(detectFramework(makeConfigs({ composerJson: { require: { 'symfony/framework-bundle': '^6.0' } } }), '')).toBe('PHP + Symfony')
  })

  it('detects plain PHP', () => {
    expect(detectFramework(makeConfigs({ composerJson: { require: {} } }), '')).toBe('PHP')
  })

  // ─── Node.js ───
  it('detects Next.js', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { next: '13.0.0', react: '18.0.0' } } }), '')).toBe('Next.js')
  })

  it('detects Nuxt.js', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { nuxt: '3.0.0', vue: '3.0.0' } } }), '')).toBe('Nuxt.js')
  })

  it('detects Remix', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { remix: '2.0.0' } } }), '')).toBe('Remix')
  })

  it('detects SvelteKit', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { '@sveltejs/kit': '1.0.0' } } }), '')).toBe('SvelteKit')
  })

  it('detects Astro', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { astro: '3.0.0' } } }), '')).toBe('Astro')
  })

  it('detects Electron + React', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { electron: '25.0.0', react: '18.0.0', 'react-dom': '18.0.0' } } }), '')).toBe('Electron + React')
  })

  it('detects Electron + Vue', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { electron: '25.0.0', vue: '3.0.0' } } }), '')).toBe('Electron + Vue')
  })

  it('detects Electron alone', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { electron: '25.0.0' } } }), '')).toBe('Electron')
  })

  it('detects React', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { react: '18.0.0', 'react-dom': '18.0.0' } } }), '')).toBe('React')
  })

  it('detects React Native', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { react: '18.0.0', 'react-dom': '18.0.0', 'react-native': '0.72.0' } } }), '')).toBe('React Native')
  })

  it('detects Expo', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { react: '18.0.0', 'react-dom': '18.0.0', expo: '49.0.0' } } }), '')).toBe('Expo')
  })

  it('detects Vue', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { vue: '3.0.0' } } }), '')).toBe('Vue')
  })

  it('detects Vue + Quasar', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { vue: '3.0.0', quasar: '2.0.0' } } }), '')).toBe('Vue + Quasar')
  })

  it('detects Angular', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { '@angular/core': '16.0.0' } } }), '')).toBe('Angular')
  })

  it('detects NestJS', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { '@nestjs/core': '10.0.0' } } }), '')).toBe('NestJS')
  })

  it('detects Express', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { express: '4.18.0' } } }), '')).toBe('Node.js + Express')
  })

  it('detects Koa', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { koa: '2.14.0' } } }), '')).toBe('Node.js + Koa')
  })

  it('detects Fastify', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { fastify: '4.20.0' } } }), '')).toBe('Node.js + Fastify')
  })

  it('detects plain Node.js', () => {
    expect(detectFramework(makeConfigs({ packageJson: { dependencies: { lodash: '4.17.0' } } }), '')).toBe('Node.js')
  })

  // ─── Fallback ───
  it('returns Generic when no configs present', () => {
    expect(detectFramework(makeConfigs(), '')).toBe('Generic')
  })
})
