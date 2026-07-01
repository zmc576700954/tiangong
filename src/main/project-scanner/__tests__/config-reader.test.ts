import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readConfigs, parseToml } from '../config-reader'

describe('parseToml', () => {
  it('parses simple key-value pairs', () => {
    const result = parseToml('name = "myapp"\nversion = "1.0"')
    expect(result.name).toBe('myapp')
    expect(result.version).toBe('1.0')
  })

  it('parses numbers', () => {
    const result = parseToml('port = 8080\nratio = 3.14')
    expect(result.port).toBe(8080)
    expect(result.ratio).toBeCloseTo(3.14)
  })

  it('parses booleans', () => {
    const result = parseToml('debug = true\nverbose = false')
    expect(result.debug).toBe(true)
    expect(result.verbose).toBe(false)
  })

  it('parses sections', () => {
    const result = parseToml('[package]\nname = "app"\n\n[dependencies]\nserde = "1.0"')
    expect((result.package as Record<string, unknown>).name).toBe('app')
    expect((result.dependencies as Record<string, unknown>).serde).toBe('1.0')
  })

  it('parses arrays', () => {
    const result = parseToml('authors = ["Alice", "Bob"]')
    expect(result.authors).toEqual(['Alice', 'Bob'])
  })

  it('handles comments', () => {
    const result = parseToml('# comment\nname = "app"\n# another comment')
    expect(result.name).toBe('app')
  })

  it('handles empty lines', () => {
    const result = parseToml('\n\nname = "app"\n\n')
    expect(result.name).toBe('app')
  })

  it('parses multi-line strings', () => {
    const toml = 'desc = """Hello\nWorld"""'
    const result = parseToml(toml)
    expect(result.desc).toBe('Hello\nWorld')
  })

  it('parses single-line multi-line strings', () => {
    const result = parseToml('desc = """inline"""')
    expect(result.desc).toBe('inline')
  })

  it('handles negative numbers', () => {
    const result = parseToml('value = -42')
    expect(result.value).toBe(-42)
  })
})

describe('readConfigs', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-reader-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reads package.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-app', version: '1.0.0' }))
    const configs = await readConfigs(tmpDir)
    expect(configs.packageJson).toEqual({ name: 'test-app', version: '1.0.0' })
  })

  it('reads go.mod', async () => {
    await fs.writeFile(path.join(tmpDir, 'go.mod'), 'module myproject\n\ngo 1.21')
    const configs = await readConfigs(tmpDir)
    expect(configs.goMod).toContain('module myproject')
  })

  it('reads Cargo.toml', async () => {
    await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "myapp"')
    const configs = await readConfigs(tmpDir)
    expect(configs.cargoToml).toEqual({ package: { name: 'myapp' } })
  })

  it('reads requirements.txt', async () => {
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==3.0.0\nrequests>=2.28')
    const configs = await readConfigs(tmpDir)
    expect(configs.requirementsTxt).toContain('flask')
  })

  it('reads pom.xml', async () => {
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), '<project></project>')
    const configs = await readConfigs(tmpDir)
    expect(configs.pomXml).toBe('<project></project>')
  })

  it('reads build.gradle', async () => {
    await fs.writeFile(path.join(tmpDir, 'build.gradle'), 'plugins { }')
    const configs = await readConfigs(tmpDir)
    expect(configs.gradleBuild).toBe('plugins { }')
  })

  it('reads Gemfile', async () => {
    await fs.writeFile(path.join(tmpDir, 'Gemfile'), "source 'https://rubygems.org'")
    const configs = await readConfigs(tmpDir)
    expect(configs.gemfile).toContain('rubygems')
  })

  it('reads composer.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'composer.json'), JSON.stringify({ require: {} }))
    const configs = await readConfigs(tmpDir)
    expect(configs.composerJson).toEqual({ require: {} })
  })

  it('returns null for missing files', async () => {
    const configs = await readConfigs(tmpDir)
    expect(configs.packageJson).toBeNull()
    expect(configs.goMod).toBeNull()
    expect(configs.cargoToml).toBeNull()
  })

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{invalid json')
    const configs = await readConfigs(tmpDir)
    expect(configs.packageJson).toBeNull()
  })
})
