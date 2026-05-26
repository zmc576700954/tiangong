import { describe, it, expect } from 'vitest'
import { isValidIdentifier, safeIdentifier } from '../database'
import { DatabaseError } from '../errors'

describe('Database - Identifier Safety', () => {
  it('should accept valid SQLite identifiers', () => {
    expect(isValidIdentifier('graphs')).toBe(true)
    expect(isValidIdentifier('nodes_backup')).toBe(true)
    expect(isValidIdentifier('_private')).toBe(true)
    expect(isValidIdentifier('Table123')).toBe(true)
  })

  it('should reject invalid identifiers', () => {
    expect(isValidIdentifier('graphs; DROP TABLE users;')).toBe(false)
    expect(isValidIdentifier('123invalid')).toBe(false)
    expect(isValidIdentifier('name"injection')).toBe(false)
    expect(isValidIdentifier('space name')).toBe(false)
    expect(isValidIdentifier('hyphen-name')).toBe(false)
    expect(isValidIdentifier('')).toBe(false)
  })

  it('should safely wrap valid identifiers', () => {
    expect(safeIdentifier('graphs')).toBe('"graphs"')
    expect(safeIdentifier('nodes')).toBe('"nodes"')
  })

  it('should escape quotes in identifiers', () => {
    // Even though isValidIdentifier rejects quotes, safeIdentifier should handle them if called directly
    // But primarily it throws for invalid identifiers
    expect(() => safeIdentifier('bad"name')).toThrow(DatabaseError)
  })

  it('should throw for SQL injection attempts', () => {
    expect(() => safeIdentifier('users; DROP TABLE graphs;')).toThrow(DatabaseError)
    expect(() => safeIdentifier('graphs --')).toThrow(DatabaseError)
    expect(() => safeIdentifier('graphs /*')).toThrow(DatabaseError)
  })
})
