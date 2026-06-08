import { describe, it, expect } from 'vitest'
import { extractEntities } from '../project-scanner/entity-parser'
import { extractRoutes } from '../project-scanner/route-parser'
import type { FileAnalysis } from '../project-scanner/types'

// ==================== extractEntities ====================
describe('extractEntities', () => {
  describe('TypeScript/Node.js 实体提取', () => {
    it('提取 TypeScript class 和字段', () => {
      const files: FileAnalysis[] = [{
        filePath: 'src/models/User.ts',
        content: `
class User {
  id: string
  name: string
  email?: string
  age: number
}`,
        language: 'typescript',
        purpose: 'model',
      }]

      const entities = extractEntities(files, 'TypeScript')
      expect(entities).toHaveLength(1)
      expect(entities[0].name).toBe('User')
      expect(entities[0].fields.length).toBeGreaterThanOrEqual(3)
      expect(entities[0].file).toBe('src/models/User.ts')
    })

    it('跳过无字段的类', () => {
      const files: FileAnalysis[] = [{
        filePath: 'src/util.ts',
        content: 'class Helper {}',
        language: 'typescript',
        purpose: 'model',
      }]
      const entities = extractEntities(files, 'Node.js')
      expect(entities).toHaveLength(0)
    })

    it('@Entity 装饰器 → 即使无字段也提取', () => {
      const files: FileAnalysis[] = [{
        filePath: 'src/models/Order.ts',
        content: 'class Order {\n  @Entity\n}',
        language: 'typescript',
        purpose: 'model',
      }]
      const entities = extractEntities(files, 'Node.js')
      expect(entities).toHaveLength(1)
    })

    it('只处理 purpose=model 或 entity 的文件', () => {
      const files: FileAnalysis[] = [{
        filePath: 'src/service.ts',
        content: 'class UserService { private db: Database }',
        language: 'typescript',
        purpose: 'service',
      }]
      const entities = extractEntities(files, 'TypeScript')
      expect(entities).toHaveLength(0)
    })
  })

  describe('Python 实体提取', () => {
    it('提取 Python class 字段', () => {
      const files: FileAnalysis[] = [{
        filePath: 'models.py',
        content: `
class Product:
    name = models.CharField(max_length=100)
    price = models.DecimalField(max_digits=10)
`,
        language: 'python',
        purpose: 'model',
      }]

      const entities = extractEntities(files, 'Python + Django')
      expect(entities).toHaveLength(1)
      expect(entities[0].name).toBe('Product')
      expect(entities[0].fields).toContain('name')
      expect(entities[0].fields).toContain('price')
    })

    it('跳过 Test 开头的类', () => {
      const files: FileAnalysis[] = [{
        filePath: 'test_models.py',
        content: 'class TestUser:\n    name = Column(String)',
        language: 'python',
        purpose: 'model',
      }]
      const entities = extractEntities(files, 'Python')
      expect(entities).toHaveLength(0)
    })
  })

  describe('Go 实体提取', () => {
    it('提取 Go struct', () => {
      const files: FileAnalysis[] = [{
        filePath: 'models/user.go',
        content: `
type User struct {
    ID    int
    Name  string
    Email string
}
`,
        language: 'go',
        purpose: 'model',
      }]

      const entities = extractEntities(files, 'Go + Gin')
      expect(entities).toHaveLength(1)
      expect(entities[0].name).toBe('User')
      expect(entities[0].fields).toContain('ID')
      expect(entities[0].fields).toContain('Name')
    })
  })

  describe('Java 实体提取', () => {
    it('提取 Java class 字段', () => {
      const files: FileAnalysis[] = [{
        filePath: 'src/main/java/User.java',
        content: `
public class User {
    private String name;
    private int age;
    private String email;
}
`,
        language: 'java',
        purpose: 'model',
      }]

      const entities = extractEntities(files, 'Java + Spring Boot')
      expect(entities).toHaveLength(1)
      expect(entities[0].name).toBe('User')
      expect(entities[0].fields.length).toBeGreaterThanOrEqual(2)
    })

    it('跳过 Test 结尾的类', () => {
      const files: FileAnalysis[] = [{
        filePath: 'UserServiceTest.java',
        content: 'class UserServiceTest {\n    private String mockData;\n}',
        language: 'java',
        purpose: 'model',
      }]
      const entities = extractEntities(files, 'Java')
      expect(entities).toHaveLength(0)
    })
  })

  describe('边界条件', () => {
    it('空文件列表 → 空结果', () => {
      expect(extractEntities([], 'Go')).toEqual([])
    })

    it('字段数限制 10 个', () => {
      const fields = Array.from({ length: 15 }, (_, i) => `  field${i}: string`).join('\n')
      const files: FileAnalysis[] = [{
        filePath: 'model.ts',
        content: `class BigModel {\n${fields}\n}`,
        language: 'typescript',
        purpose: 'model',
      }]
      const entities = extractEntities(files, 'TypeScript')
      expect(entities[0].fields.length).toBeLessThanOrEqual(10)
    })
  })
})

// ==================== extractRoutes ====================
describe('extractRoutes', () => {
  describe('Express/Node.js 路由', () => {
    it('提取 app.get/post/put/delete', () => {
      const files: FileAnalysis[] = [{
        filePath: 'routes/api.ts',
        content: `
app.get('/users', handler)
app.post('/users', handler)
app.put('/users/:id', handler)
app.delete('/users/:id', handler)
router.patch('/items/:id', handler)
`,
        language: 'typescript',
        purpose: 'route',
      }]

      const routes = extractRoutes(files, 'Node.js + Express')
      expect(routes).toHaveLength(5)
      expect(routes[0].method).toBe('GET')
      expect(routes[0].path).toBe('/users')
      expect(routes[1].method).toBe('POST')
    })
  })

  describe('FastAPI 路由', () => {
    it('提取 @app.get/post 装饰器', () => {
      const files: FileAnalysis[] = [{
        filePath: 'main.py',
        content: `
@app.get("/items")
@app.post("/items")
@router.get("/users/{id}")
`,
        language: 'python',
        purpose: 'route',
      }]

      const routes = extractRoutes(files, 'Python + FastAPI')
      expect(routes).toHaveLength(3)
      expect(routes[0].method).toBe('GET')
      expect(routes[0].path).toBe('/items')
    })
  })

  describe('Go 路由', () => {
    it('提取 r.GET/POST', () => {
      const files: FileAnalysis[] = [{
        filePath: 'routes.go',
        content: `
r.GET("/users", handler)
r.POST("/users", handler)
r.PUT("/users/:id", handler)
`,
        language: 'go',
        purpose: 'route',
      }]

      const routes = extractRoutes(files, 'Go + Gin')
      expect(routes).toHaveLength(3)
      expect(routes[0].method).toBe('GET')
    })
  })

  describe('Spring 路由', () => {
    it('提取 @GetMapping/@PostMapping', () => {
      const files: FileAnalysis[] = [{
        filePath: 'UserController.java',
        content: `
@GetMapping("/users")
@PostMapping("/users")
@RequestMapping("/api")
`,
        language: 'java',
        purpose: 'route',
      }]

      const routes = extractRoutes(files, 'Java + Spring Boot')
      expect(routes).toHaveLength(3)
      expect(routes[0].path).toBe('/users')
    })
  })

  describe('NestJS 控制器', () => {
    it('从 @Controller 基路径 + 方法装饰器提取', () => {
      const files: FileAnalysis[] = [{
        filePath: 'users.controller.ts',
        content: `
@Controller('users')
export class UsersController {
  @Get('/')
  findAll() {}
  @Post('/')
  create() {}
}
`,
        language: 'typescript',
        purpose: 'controller',
      }]

      const routes = extractRoutes(files, 'NestJS')
      expect(routes).toHaveLength(2)
      expect(routes[0].path).toBe('users/')
    })
  })

  describe('Django 路由', () => {
    it('从 controller 文件中提取 path()', () => {
      const files: FileAnalysis[] = [{
        filePath: 'urls.py',
        content: `
path('users/', views.list_users)
path('users/<int:pk>/', views.get_user)
`,
        language: 'python',
        purpose: 'controller',
      }]

      const routes = extractRoutes(files, 'Python + Django')
      expect(routes).toHaveLength(2)
      expect(routes[0].path).toBe('users/')
    })
  })

  describe('边界条件', () => {
    it('空文件列表 → 空结果', () => {
      expect(extractRoutes([], 'Express')).toEqual([])
    })

    it('只处理 purpose=route 和 controller 的文件', () => {
      const files: FileAnalysis[] = [{
        filePath: 'service.ts',
        content: "app.get('/test', handler)",
        language: 'typescript',
        purpose: 'service',
      }]
      const routes = extractRoutes(files, 'Express')
      expect(routes).toHaveLength(0)
    })
  })
})
