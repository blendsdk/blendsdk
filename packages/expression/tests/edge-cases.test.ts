/**
 * Edge cases and error handling tests
 */

import { describe, it, expect } from 'vitest';
import { query } from '../src/index.js';

describe('Expression2 - Edge Cases', () => {
  describe('Empty and null values', () => {
    it('should handle empty string values', () => {
      const result = query()
        .where('name').equals('')
        .compile();

      expect(result.sql).toBe('name = :p1');
      expect(result.params).toEqual({ p1: '' });
    });

    it('should handle null values in equals', () => {
      const result = query()
        .where('value').equals(null)
        .compile();

      expect(result.sql).toBe('value = :p1');
      expect(result.params).toEqual({ p1: null });
    });

    it('should handle undefined values in equals', () => {
      const result = query()
        .where('value').equals(undefined)
        .compile();

      expect(result.sql).toBe('value = :p1');
      expect(result.params).toEqual({ p1: null });
    });

    it('should handle zero values', () => {
      const result = query()
        .where('count').equals(0)
        .compile();

      expect(result.sql).toBe('count = :p1');
      expect(result.params).toEqual({ p1: 0 });
    });

    it('should handle false boolean values', () => {
      const result = query()
        .where('active').equals(false)
        .compile();

      expect(result.sql).toBe('active = :p1');
      expect(result.params).toEqual({ p1: false });
    });

    it('should handle empty arrays in IN operator', () => {
      const result = query()
        .where('status').in([])
        .compile();

      expect(result.sql).toBe('status IN ()');
      expect(result.params).toEqual({});
    });
  });

  describe('Special characters', () => {
    it('should handle single quotes in values', () => {
      const result = query()
        .where('name').equals("O'Brien")
        .compile();

      expect(result.sql).toBe('name = :p1');
      expect(result.params).toEqual({ p1: "O'Brien" });
    });

    it('should handle double quotes in values', () => {
      const result = query()
        .where('quote').equals('He said "hello"')
        .compile();

      expect(result.sql).toBe('quote = :p1');
      expect(result.params).toEqual({ p1: 'He said "hello"' });
    });

    it('should handle backslashes in values', () => {
      const result = query()
        .where('path').equals('C:\\Users\\test')
        .compile();

      expect(result.sql).toBe('path = :p1');
      expect(result.params).toEqual({ p1: 'C:\\Users\\test' });
    });

    it('should handle newlines in values', () => {
      const result = query()
        .where('text').equals('line1\nline2')
        .compile();

      expect(result.sql).toBe('text = :p1');
      expect(result.params).toEqual({ p1: 'line1\nline2' });
    });

    it('should handle unicode characters', () => {
      const result = query()
        .where('name').equals('José García 日本語')
        .compile();

      expect(result.sql).toBe('name = :p1');
      expect(result.params).toEqual({ p1: 'José García 日本語' });
    });
  });

  describe('Complex nested conditions', () => {
    it('should handle deeply nested conditions', () => {
      const result = query()
        .where('a').equals(1)
        .and(q1 => q1
          .where('b').equals(2)
          .or(q2 => q2
            .where('c').equals(3)
            .and('d').equals(4)
          )
        )
        .compile();

      expect(result.sql).toBe('a = :p1 AND (b = :p2 OR (c = :p3 AND d = :p4))');
      expect(result.params).toEqual({ p1: 1, p2: 2, p3: 3, p4: 4 });
    });

    it('should handle multiple nested groups at same level', () => {
      const result = query()
        .where(q => q
          .where('a').equals(1)
          .or('b').equals(2)
        )
        .and(q => q
          .where('c').equals(3)
          .or('d').equals(4)
        )
        .compile();

      expect(result.sql).toBe('(a = :p1 OR b = :p2) AND (c = :p3 OR d = :p4)');
      expect(result.params).toEqual({ p1: 1, p2: 2, p3: 3, p4: 4 });
    });

    it('should handle empty nested conditions', () => {
      const result = query()
        .where('a').equals(1)
        .and(q => q)
        .compile();

      // Empty nested condition should be ignored
      expect(result.sql).toBe('a = :p1');
      expect(result.params).toEqual({ p1: 1 });
    });
  });

  describe('Large datasets', () => {
    it('should handle large IN arrays', () => {
      const values = Array.from({ length: 100 }, (_, i) => i);
      const result = query()
        .where('id').in(values)
        .compile();

      expect(result.sql).toContain('id IN (');
      expect(result.sql.split(',').length).toBe(100);
      expect(Object.keys(result.params).length).toBe(100);
    });

    it('should handle many AND conditions', () => {
      let q = query().where('a').equals(1);
      
      for (let i = 2; i <= 20; i++) {
        q = q.and(`col${i}`).equals(i);
      }

      const result = q.compile();
      
      expect(result.sql.split('AND').length).toBe(20);
      expect(Object.keys(result.params).length).toBe(20);
    });
  });

  describe('Column names', () => {
    it('should handle column names with underscores', () => {
      const result = query()
        .where('user_id').equals(123)
        .compile();

      expect(result.sql).toBe('user_id = :p1');
    });

    it('should handle column names with dots (table.column)', () => {
      const result = query()
        .where('users.id').equals(123)
        .compile();

      expect(result.sql).toBe('users.id = :p1');
    });

    it('should handle column names with schema prefix', () => {
      const result = query()
        .where('public.users.id').equals(123)
        .compile();

      expect(result.sql).toBe('public.users.id = :p1');
    });
  });

  describe('BETWEEN operator edge cases', () => {
    it('should handle BETWEEN with same min and max', () => {
      const result = query()
        .where('age').between(18, 18)
        .compile();

      expect(result.sql).toBe('age BETWEEN :p1 AND :p2');
      expect(result.params).toEqual({ p1: 18, p2: 18 });
    });

    it('should handle BETWEEN with negative numbers', () => {
      const result = query()
        .where('temperature').between(-10, 5)
        .compile();

      expect(result.sql).toBe('temperature BETWEEN :p1 AND :p2');
      expect(result.params).toEqual({ p1: -10, p2: 5 });
    });

    it('should handle BETWEEN with decimal numbers', () => {
      const result = query()
        .where('price').between(9.99, 99.99)
        .compile();

      expect(result.sql).toBe('price BETWEEN :p1 AND :p2');
      expect(result.params).toEqual({ p1: 9.99, p2: 99.99 });
    });
  });

  describe('LIKE pattern edge cases', () => {
    it('should handle LIKE with only wildcards', () => {
      const result = query()
        .where('name').like('%%')
        .compile();

      expect(result.sql).toBe('name LIKE :p1');
      expect(result.params).toEqual({ p1: '%%' });
    });

    it('should handle LIKE with escaped characters', () => {
      const result = query()
        .where('name').like('%\\_%')
        .compile();

      expect(result.sql).toBe('name LIKE :p1');
      expect(result.params).toEqual({ p1: '%\\_%' });
    });

    it('should handle startsWith with empty string', () => {
      const result = query()
        .where('name').startsWith('')
        .compile();

      expect(result.sql).toBe('name LIKE :p1');
      expect(result.params).toEqual({ p1: '%' });
    });
  });

  describe('JSON operations edge cases', () => {
    it('should handle JSON contains with nested objects', () => {
      const result = query()
        .where('data').jsonContains({
          user: {
            profile: {
              age: 25
            }
          }
        })
        .compile();

      expect(result.sql).toBe('data @> :p1');
      expect(result.params.p1).toEqual({
        user: {
          profile: {
            age: 25
          }
        }
      });
    });

    it('should handle JSON contains with arrays', () => {
      const result = query()
        .where('tags').jsonContains(['javascript', 'typescript'])
        .compile();

      expect(result.sql).toBe('tags @> :p1');
      expect(result.params).toEqual({ p1: ['javascript', 'typescript'] });
    });

    it('should handle JSON has key with special characters', () => {
      const result = query()
        .where('metadata').jsonHasKey('user-email')
        .compile();

      expect(result.sql).toBe('metadata ? :p1');
      expect(result.params).toEqual({ p1: 'user-email' });
    });

    it('should handle JSON has any key with empty array', () => {
      const result = query()
        .where('metadata').jsonHasAnyKey([])
        .compile();

      expect(result.sql).toBe('metadata ?| :p1');
      expect(result.params).toEqual({ p1: [] });
    });
  });

  describe('Full-text search edge cases', () => {
    it('should handle search with special characters', () => {
      const result = query()
        .where('content').search('C++ programming')
        .compile();

      expect(result.sql).toContain("plainto_tsquery('english', :p1)");
      expect(result.params).toEqual({ p1: 'C++ programming' });
    });

    it('should handle search with quotes', () => {
      const result = query()
        .where('content').search('"exact phrase"')
        .compile();

      expect(result.sql).toContain("plainto_tsquery('english', :p1)");
      expect(result.params).toEqual({ p1: '"exact phrase"' });
    });

    it('should handle multi-column search with many columns', () => {
      const result = query()
        .search(['col1', 'col2', 'col3', 'col4', 'col5'], 'search term')
        .compile();

      expect(result.sql).toContain("col1 || ' ' || col2 || ' ' || col3 || ' ' || col4 || ' ' || col5");
      expect(result.params).toEqual({ p1: 'search term' });
    });
  });

  describe('Mixed operator combinations', () => {
    it('should handle all comparison operators together', () => {
      const result = query()
        .where('a').equals(1)
        .and('b').notEquals(2)
        .and('c').greaterThan(3)
        .and('d').lessThan(4)
        .and('e').between(5, 6)
        .and('f').in([7, 8])
        .and('g').like('%test%')
        .and('h').isNull()
        .compile();

      expect(result.sql).toContain('a = :p1');
      expect(result.sql).toContain('b <> :p2'); // PostgreSQL uses <> not !=
      expect(result.sql).toContain('c > :p3');
      expect(result.sql).toContain('d < :p4');
      expect(result.sql).toContain('e BETWEEN :p5 AND :p6');
      expect(result.sql).toContain('f IN (:p7, :p8)');
      expect(result.sql).toContain('g LIKE :p9');
      expect(result.sql).toContain('h IS NULL');
    });

    it('should handle mix of AND and OR with different operators', () => {
      const result = query()
        .where('status').in(['active', 'pending'])
        .and(q => q
          .where('age').between(18, 65)
          .or('verified').equals(true)
        )
        .and('deleted_at').isNull()
        .compile();

      expect(result.sql).toBe(
        'status IN (:p1, :p2) AND (age BETWEEN :p3 AND :p4 OR verified = :p5) AND deleted_at IS NULL'
      );
    });
  });

  describe('Parameter numbering', () => {
    it('should maintain correct parameter numbering across complex queries', () => {
      const result = query()
        .where('a').equals(1)
        .and('b').in([2, 3, 4])
        .and(q => q
          .where('c').between(5, 6)
          .or('d').equals(7)
        )
        .and('e').like('%8%')
        .compile();

      expect(result.params).toEqual({
        p1: 1,
        p2: 2,
        p3: 3,
        p4: 4,
        p5: 5,
        p6: 6,
        p7: 7,
        p8: '%8%'
      });
    });

    it('should handle parameter numbering with multiple nested groups', () => {
      const result = query()
        .where('a').equals(1)
        .and(q1 => q1
          .where('b').equals(2)
          .and(q2 => q2
            .where('c').equals(3)
            .or('d').equals(4)
          )
        )
        .or('e').equals(5)
        .compile();

      expect(Object.keys(result.params).length).toBe(5);
      expect(result.params).toEqual({
        p1: 1,
        p2: 2,
        p3: 3,
        p4: 4,
        p5: 5
      });
    });
  });
});
