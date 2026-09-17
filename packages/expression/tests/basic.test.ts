/**
 * Basic tests for expression2
 */

import { describe, it, expect } from 'vitest';
import { query, SqlDialect } from '../src/index.js';

describe('Expression2 - Basic Tests', () => {
  describe('Simple comparisons', () => {
    it('should create simple equality condition', () => {
      const result = query().where('status').equals('active').compile();

      expect(result.sql).toBe('status = :p1');
      expect(result.params).toEqual({ p1: 'active' });
    });

    it('should create greater than condition', () => {
      const result = query().where('age').greaterThan(18).compile();

      expect(result.sql).toBe('age > :p1');
      expect(result.params).toEqual({ p1: 18 });
    });

    it('should create LIKE condition', () => {
      const result = query().where('email').like('%@gmail.com').compile();

      expect(result.sql).toBe('email LIKE :p1');
      expect(result.params).toEqual({ p1: '%@gmail.com' });
    });

    it('should create IS NULL condition', () => {
      const result = query().where('deleted_at').isNull().compile();

      expect(result.sql).toBe('deleted_at IS NULL');
      expect(result.params).toEqual({});
    });

    it('should create BETWEEN condition', () => {
      const result = query().where('age').between(18, 65).compile();

      expect(result.sql).toBe('age BETWEEN :p1 AND :p2');
      expect(result.params).toEqual({ p1: 18, p2: 65 });
    });

    it('should create IN condition', () => {
      const result = query().where('status').in(['active', 'pending']).compile();

      expect(result.sql).toBe('status IN (:p1, :p2)');
      expect(result.params).toEqual({ p1: 'active', p2: 'pending' });
    });
  });

  describe('Logical operators', () => {
    it('should create AND condition', () => {
      const result = query()
        .where('status').equals('active')
        .and('age').greaterThan(18)
        .compile();

      expect(result.sql).toBe('status = :p1 AND age > :p2');
      expect(result.params).toEqual({ p1: 'active', p2: 18 });
    });

    it('should create OR condition', () => {
      const result = query()
        .where('role').equals('admin')
        .or('role').equals('moderator')
        .compile();

      expect(result.sql).toBe('role = :p1 OR role = :p2');
      expect(result.params).toEqual({ p1: 'admin', p2: 'moderator' });
    });

    it('should create nested conditions with grouping', () => {
      const result = query()
        .where('status').equals('active')
        .and(q => q
          .where('age').greaterThan(21)
          .or('verified').equals(true)
        )
        .compile();

      expect(result.sql).toBe('status = :p1 AND (age > :p2 OR verified = :p3)');
      expect(result.params).toEqual({ p1: 'active', p2: 21, p3: true });
    });
  });

  describe('Type safety', () => {
    interface User {
      id: number;
      email: string;
      age: number;
      status: string;
    }

    it('should provide type-safe column access', () => {
      const result = query<User>()
        .where('email').equals('test@example.com')
        .and('age').greaterThan(18)
        .compile();

      expect(result.sql).toBe('email = :p1 AND age > :p2');
      expect(result.params).toEqual({ p1: 'test@example.com', p2: 18 });
    });
  });

  describe('Helper methods', () => {
    it('should support startsWith', () => {
      const result = query().where('name').startsWith('John').compile();

      expect(result.sql).toBe('name LIKE :p1');
      expect(result.params).toEqual({ p1: 'John%' });
    });

    it('should support endsWith', () => {
      const result = query().where('name').endsWith('Smith').compile();

      expect(result.sql).toBe('name LIKE :p1');
      expect(result.params).toEqual({ p1: '%Smith' });
    });

    it('should support contains', () => {
      const result = query().where('description').contains('important').compile();

      expect(result.sql).toBe('description LIKE :p1');
      expect(result.params).toEqual({ p1: '%important%' });
    });
  });

  describe('JSON operations', () => {
    it('should create JSON contains condition', () => {
      const result = query()
        .where('data').jsonContains({ type: 'premium' })
        .compile();

      expect(result.sql).toBe('data @> :p1');
      expect(result.params).toEqual({ p1: { type: 'premium' } });
    });

    it('should create JSON has key condition', () => {
      const result = query()
        .where('metadata').jsonHasKey('email')
        .compile();

      expect(result.sql).toBe('metadata ? :p1');
      expect(result.params).toEqual({ p1: 'email' });
    });
  });

  describe('Full-text search', () => {
    it('should create simple full-text search', () => {
      const result = query()
        .where('content').search('javascript')
        .compile();

      expect(result.sql).toContain("to_tsvector('english', content)");
      expect(result.sql).toContain("plainto_tsquery('english', :p1)");
      expect(result.params).toEqual({ p1: 'javascript' });
    });

    it('should create multi-column full-text search', () => {
      const result = query()
        .search(['title', 'content'], 'javascript tutorial')
        .compile();

      expect(result.sql).toContain("to_tsvector('english', title || ' ' || content)");
      expect(result.sql).toContain("plainto_tsquery('english', :p1)");
      expect(result.params).toEqual({ p1: 'javascript tutorial' });
    });
  });

  describe('Debug mode', () => {
    it('should include debug information when enabled', () => {
      const result = query({ debug: true })
        .where('status').equals('active')
        .compile();

      expect(result.debug).toBeDefined();
      expect(result.debug?.ast).toBeDefined();
      expect(result.debug?.parameterCount).toBe(1);
      expect(result.debug?.compilationTime).toBeGreaterThanOrEqual(0);
    });

    it('should not include debug information by default', () => {
      const result = query()
        .where('status').equals('active')
        .compile();

      expect(result.debug).toBeUndefined();
    });
  });

  describe('Empty query', () => {
    it('should handle empty query', () => {
      const result = query().compile();

      expect(result.sql).toBe('');
      expect(result.params).toEqual({});
    });
  });
});
