import { describe, expect, test } from 'vitest';

import {
  getDomainValidationError,
  getEmailValidationError,
  isValidDomain,
  isValidEmail,
} from '../src/validators.js';

describe('Email Validation', () => {
  describe('isValidEmail', () => {
    test('should validate correct email addresses', () => {
      const validEmails = [
        'test@example.com',
        'user.name@domain.co.uk',
        'user+tag@example.org',
        'user_name@example-domain.com',
        'test123@sub.domain.com',
        'a@b.co',
        'test.email.with+symbol@example.com',
        'x@example.com',
        '123@example.com',
        'test@example-one.com',
        'test@example_one.com',
      ];

      validEmails.forEach(email => {
        expect(isValidEmail(email)).toBe(true);
      });
    });

    test('should reject invalid email addresses', () => {
      const invalidEmails = [
        '',
        'invalid',
        '@example.com',
        'test@',
        'test..test@example.com',
        '.test@example.com',
        'test.@example.com',
        'test@example', // single-label domain not allowed for emails
        'test@localhost', // single-label domain not allowed for emails
        'test@.example.com',
        'test@example..com',
        'test@example.com.',
        'test@example.c',
        'test@',
        '@',
        'test@@example.com',
        'test@example@com',
        'a'.repeat(65) + '@example.com', // local part too long
        'test@' + 'a'.repeat(254) + '.com', // domain too long
        123 as any,
        null as any,
        undefined as any,
      ];

      invalidEmails.forEach(email => {
        expect(isValidEmail(email)).toBe(false);
      });
    });
  });

  describe('getEmailValidationError', () => {
    test('should return appropriate error messages', () => {
      expect(getEmailValidationError(123 as any)).toBe('Email must be a string');
      expect(getEmailValidationError('')).toBe('Email cannot be empty');
      expect(getEmailValidationError('invalid')).toBe('Email must contain @ symbol');
      expect(getEmailValidationError('test@@example.com')).toBe(
        'Email must contain exactly one @ symbol'
      );
      expect(getEmailValidationError('@example.com')).toBe('Email must have a local part before @');
      expect(getEmailValidationError('test@')).toBe('Email must have a domain part after @');
      expect(getEmailValidationError('test..test@example.com')).toBe(
        'Email cannot contain consecutive dots'
      );
      expect(getEmailValidationError('.test@example.com')).toBe(
        'Email local part cannot start or end with a dot'
      );
      expect(getEmailValidationError('test.@example.com')).toBe(
        'Email local part cannot start or end with a dot'
      );
    });
  });
});

describe('Domain Validation', () => {
  describe('isValidDomain', () => {
    test('should validate correct domain names', () => {
      const validDomains = [
        'example.com',
        'sub.example.com',
        'deep.sub.example.com',
        'example-domain.com',
        'example123.com',
        '123example.com',
        'a.com',
        'x.y.z',
        'localhost',
        'test-domain.co.uk',
        'very-long-subdomain-name.example.com',
        'example.museum',
        'xn--example.com', // internationalized domain
        'test.example-with-hyphens.com',
      ];

      validDomains.forEach(domain => {
        expect(isValidDomain(domain)).toBe(true);
      });
    });

    test('should reject invalid domain names', () => {
      const invalidDomains = [
        '',
        '.',
        '..',
        '.example.com',
        'example.com.',
        '-example.com',
        'example-.com',
        'example.-com',
        'example.com-',
        'example..com',
        'example.c-m',
        'example.123', // TLD with no letters
        'a'.repeat(64) + '.com', // label too long
        'a'.repeat(254), // domain too long
        'example.com.', // trailing dot
        'exam ple.com', // space in domain
        'example.com/path', // path included
        'http://example.com', // protocol included
        123 as any,
        null as any,
        undefined as any,
      ];

      invalidDomains.forEach(domain => {
        expect(isValidDomain(domain)).toBe(false);
      });
    });
  });

  describe('getDomainValidationError', () => {
    test('should return appropriate error messages', () => {
      expect(getDomainValidationError(123 as any)).toBe('Domain must be a string');
      expect(getDomainValidationError('')).toBe('Domain cannot be empty');
      expect(getDomainValidationError('a'.repeat(254))).toBe('Domain cannot exceed 253 characters');
      expect(getDomainValidationError('.example.com')).toBe(
        'Domain cannot start or end with a dot'
      );
      expect(getDomainValidationError('example.com.')).toBe(
        'Domain cannot start or end with a dot'
      );
      expect(getDomainValidationError('-example.com')).toBe(
        'Domain cannot start or end with a hyphen'
      );
      expect(getDomainValidationError('example.com-')).toBe(
        'Domain cannot start or end with a hyphen'
      );
      expect(getDomainValidationError('example..com')).toBe('Domain labels cannot be empty');
      expect(getDomainValidationError('a'.repeat(64) + '.com')).toContain(
        'cannot exceed 63 characters'
      );
      expect(getDomainValidationError('example.-com')).toContain(
        'cannot start or end with a hyphen'
      );
      expect(getDomainValidationError('exam ple.com')).toContain('contains invalid characters');
      expect(getDomainValidationError('example.123')).toBe(
        'Top-level domain must contain at least one letter'
      );
    });
  });
});
