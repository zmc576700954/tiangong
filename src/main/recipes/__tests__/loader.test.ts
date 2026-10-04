import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

let tmpDir = ''
let userDirRoot = ''

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return userDirRoot
      return ''
    },
    isPackaged: false,
  },
}))

const { loadAllRecipes } = await import('../loader')
const { BizGraphError, ErrorCode } = await import('../../errors')

async function writeRecipe(dir: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, `${name}.yaml`), content, 'utf-8')
}

const SAMPLE_RECIPE = (title: string, instructions: string) => `
version: "1.0.0"
title: "${title}"
description: "Sample recipe for testing"
instructions: |
  ${instructions}
`

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bizgraph-recipes-test-'))
  userDirRoot = path.join(tmpDir, 'user')
  await fs.mkdir(path.join(userDirRoot, 'recipes'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'project', '.bizgraph', 'recipes'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('loadAllRecipes', () => {
  const userRecipesDir = () => path.join(userDirRoot, 'recipes')
  const projectRecipesDir = (projectRoot: string) =>
    path.join(projectRoot, '.bizgraph', 'recipes')

  it('returns empty array when both dirs are empty/missing', async () => {
    const recipes = await loadAllRecipes(path.join(tmpDir, 'project'))
    expect(recipes).toEqual([])
  })

  it('loads user-level recipe when project dir missing', async () => {
    await writeRecipe(
      userRecipesDir(),
      'refactor',
      SAMPLE_RECIPE('Refactor Component', 'refactor code'),
    )
    const recipes = await loadAllRecipes(path.join(tmpDir, 'nonexistent-project'))
    expect(recipes).toHaveLength(1)
    expect(recipes[0].title).toBe('Refactor Component')
    expect(recipes[0].source).toBe('user')
  })

  it('loads both user and project recipes', async () => {
    const projectRoot = path.join(tmpDir, 'project')
    await writeRecipe(userRecipesDir(), 'user-only', SAMPLE_RECIPE('User Only', 'x'))
    await writeRecipe(projectRecipesDir(projectRoot), 'project-only', SAMPLE_RECIPE('Project Only', 'y'))
    const recipes = await loadAllRecipes(projectRoot)
    expect(recipes).toHaveLength(2)
    const sources = recipes.map(r => r.source).sort()
    expect(sources).toEqual(['project', 'user'])
  })

  it('project overrides user when same filename', async () => {
    const projectRoot = path.join(tmpDir, 'project')
    await writeRecipe(userRecipesDir(), 'shared', SAMPLE_RECIPE('User Version', 'user body'))
    await writeRecipe(projectRecipesDir(projectRoot), 'shared', SAMPLE_RECIPE('Project Version', 'project body'))
    const recipes = await loadAllRecipes(projectRoot)
    expect(recipes).toHaveLength(1)
    expect(recipes[0].title).toBe('Project Version')
    expect(recipes[0].source).toBe('project')
  })

  it('throws BizGraphError when yaml is invalid', async () => {
    await writeRecipe(
      userRecipesDir(),
      'bad',
      `
version: "1.0.0"
title: ""
description: "empty title"
prompt: "x"
`,
    )
    await expect(loadAllRecipes(path.join(tmpDir, 'project'))).rejects.toBeInstanceOf(BizGraphError)
    try {
      await loadAllRecipes(path.join(tmpDir, 'project'))
    } catch (err) {
      expect((err as InstanceType<typeof BizGraphError>).code).toBe(ErrorCode.RECIPE_PARSE_ERROR)
    }
  })
})