/**
 * Validation utilities for command line option types
 */

/**
 * Validates if a string is a valid email address
 * @param value The value to validate
 * @returns true if valid email, false otherwise
 */
export function isValidEmail(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  // Basic email regex that covers most common cases
  // This follows RFC 5322 specification loosely but is practical for command line usage
  // Allow underscores in domain names for practical usage
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?)*$/;

  // Check basic format
  if (!emailRegex.test(value)) {
    return false;
  }

  // Additional checks
  const parts = value.split('@');
  if (parts.length !== 2) {
    return false;
  }

  const [localPart, domainPart] = parts;

  // Check local part length (before @)
  if (!localPart || localPart.length > 64) {
    return false;
  }

  // Check domain part length (after @)
  if (!domainPart || domainPart.length > 253) {
    return false;
  }

  // Check for consecutive dots
  if (value.includes('..')) {
    return false;
  }

  // Check that it doesn't start or end with a dot
  if (localPart.startsWith('.') || localPart.endsWith('.')) {
    return false;
  }

  // Validate the domain part using our domain validator
  if (!isValidDomain(domainPart)) {
    return false;
  }

  // For emails, require at least one dot in the domain (no single-label domains)
  if (!domainPart.includes('.')) {
    return false;
  }

  // For emails, require TLD to be at least 2 characters
  const domainLabels = domainPart.split('.');
  const tld = domainLabels[domainLabels.length - 1];
  if (tld && tld.length < 2) {
    return false;
  }

  return true;
}

/**
 * Validates if a string is a valid domain name (including subdomains)
 * @param value The value to validate
 * @returns true if valid domain, false otherwise
 */
export function isValidDomain(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  // Remove leading/trailing whitespace
  const domain = value.trim();

  // Check length constraints
  if (domain.length === 0 || domain.length > 253) {
    return false;
  }

  // Domain cannot start or end with a dot or hyphen
  if (
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    domain.startsWith('-') ||
    domain.endsWith('-')
  ) {
    return false;
  }

  // Split into labels (parts separated by dots)
  const labels = domain.split('.');

  // Must have at least one label
  if (labels.length === 0) {
    return false;
  }

  // Validate each label
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];

    // Label cannot be empty or undefined
    if (!label || label.length === 0) {
      return false;
    }

    // Label cannot be longer than 63 characters
    if (label.length > 63) {
      return false;
    }

    // Label cannot start or end with hyphen
    if (label.startsWith('-') || label.endsWith('-')) {
      return false;
    }

    // For non-TLD labels, allow alphanumeric characters, hyphens, and underscores
    // For TLD (last label), be more restrictive
    if (i === labels.length - 1) {
      // TLD validation: only letters and numbers, no hyphens or underscores
      // Must contain at least one letter and be at least 2 characters
      // Exception: single-label domains like "localhost" are allowed
      if (labels.length === 1) {
        // Single label domain (like localhost) - allow alphanumeric, hyphens, underscores
        if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
          return false;
        }
      } else {
        // Multi-label domain TLD - must contain at least one letter
        if (!/^[a-zA-Z0-9]+$/.test(label) || !/[a-zA-Z]/.test(label)) {
          return false;
        }
      }
    } else {
      // Non-TLD labels can contain alphanumeric characters, hyphens, and underscores
      if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Get a human-readable error message for invalid email
 * @param value The invalid email value
 * @returns Error message string
 */
export function getEmailValidationError(value: string): string {
  if (typeof value !== 'string') {
    return 'Email must be a string';
  }

  if (value.length === 0) {
    return 'Email cannot be empty';
  }

  if (!value.includes('@')) {
    return 'Email must contain @ symbol';
  }

  const parts = value.split('@');
  if (parts.length !== 2) {
    return 'Email must contain exactly one @ symbol';
  }

  const [localPart, domainPart] = parts;

  if (!localPart) {
    return 'Email must have a local part before @';
  }

  if (localPart.length > 64) {
    return 'Email local part cannot exceed 64 characters';
  }

  if (!domainPart) {
    return 'Email must have a domain part after @';
  }

  if (domainPart.length > 253) {
    return 'Email domain part cannot exceed 253 characters';
  }

  if (value.includes('..')) {
    return 'Email cannot contain consecutive dots';
  }

  if (localPart.startsWith('.') || localPart.endsWith('.')) {
    return 'Email local part cannot start or end with a dot';
  }

  return 'Invalid email format';
}

/**
 * Get a human-readable error message for invalid domain
 * @param value The invalid domain value
 * @returns Error message string
 */
export function getDomainValidationError(value: string): string {
  if (typeof value !== 'string') {
    return 'Domain must be a string';
  }

  const domain = value.trim();

  if (domain.length === 0) {
    return 'Domain cannot be empty';
  }

  if (domain.length > 253) {
    return 'Domain cannot exceed 253 characters';
  }

  if (domain.startsWith('.') || domain.endsWith('.')) {
    return 'Domain cannot start or end with a dot';
  }

  if (domain.startsWith('-') || domain.endsWith('-')) {
    return 'Domain cannot start or end with a hyphen';
  }

  const labels = domain.split('.');

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];

    if (!label || label.length === 0) {
      return 'Domain labels cannot be empty';
    }

    if (label.length > 63) {
      return `Domain label "${label}" cannot exceed 63 characters`;
    }

    if (label.startsWith('-') || label.endsWith('-')) {
      return `Domain label "${label}" cannot start or end with a hyphen`;
    }

    if (!/^[a-zA-Z0-9-]+$/.test(label)) {
      return `Domain label "${label}" contains invalid characters (only letters, numbers, and hyphens allowed)`;
    }
  }

  const tld = labels[labels.length - 1];
  if (tld && !/[a-zA-Z]/.test(tld)) {
    return 'Top-level domain must contain at least one letter';
  }

  return 'Invalid domain format';
}
