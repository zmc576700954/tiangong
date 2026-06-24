import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { scanDirectory } from '../project-scanner/dir-scanner'
import { ScopeGuardError } from '../errors'

describe('scanDirectory', () => {
  it('returns relative paths for a normal project directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-scanner-'))
    try {
      await fs.mkdir(path.join(tmpDir, 'src'))
      await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), '')
      await fs.writeFile(path.join(tmpDir, 'readme.md'), '')

      const result = await scanDirectory(tmpDir)
      expect(result).toContain('src/')
      expect(result).toContain(path.join('src', 'a.ts'))
      expect(result).toContain('readme.md')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects system directories', async () => {
    const blocked = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    await expect(scanDirectory(blocked)).rejects.toThrow(ScopeGuardError)
  })

  it('does not reject prefix-bypass siblings of system directories', async () => {
    // e.g. /etc-project or C:\Windows-project should NOT be treated as inside /etc or C:\Windows.
    const sibling = process.platform === 'win32' ? 'C:\\Windows-project' : '/etc-project'
    const result = await scanDirectory(sibling)
    expect(result).toEqual([])
  })
})
