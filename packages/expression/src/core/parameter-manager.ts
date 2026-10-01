/**
 * Parameter manager for handling SQL parameters
 * Manages parameter generation, validation, and serialization
 */

import { SqlDialect } from './types.js';

/**
 * Parameter manager class
 */
export class ParameterManager {
  private parameterCount: number = 0;
  private parameters: Map<string, any> = new Map();
  private readonly dialect: SqlDialect;

  constructor(dialect: SqlDialect = SqlDialect.PostgreSQL) {
    this.dialect = dialect;
  }

  /**
   * Generate a new unique parameter name
   */
  public generateParameterName(): string {
    this.parameterCount++;
    return this.formatParameterName(this.parameterCount);
  }

  /**
   * Add a parameter with a specific name
   */
  public addParameter(name: string, value: any): void {
    // Serialize the value before storing (normalizes undefined to null)
    const serialized = this.serializeParameter(value);
    this.parameters.set(name, serialized);
  }

  /**
   * Add a parameter and return its name
   */
  public addParameterWithValue(value: any): string {
    const name = this.generateParameterName();
    this.addParameter(name, value);
    return name;
  }

  /**
   * Get parameter value by name
   */
  public getParameter(name: string): any {
    return this.parameters.get(name);
  }

  /**
   * Check if parameter exists
   */
  public hasParameter(name: string): boolean {
    return this.parameters.has(name);
  }

  /**
   * Get all parameters as a record
   */
  public getParameters(): Record<string, any> {
    const result: Record<string, any> = {};
    this.parameters.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Get parameter count
   */
  public getParameterCount(): number {
    return this.parameterCount;
  }

  /**
   * Reset parameter manager
   */
  public reset(): void {
    this.parameterCount = 0;
    this.parameters.clear();
  }

  /**
   * Format parameter name with a sequential index.
   * Currently all dialects use the same naming convention (p1, p2, p3, etc.).
   *
   * @param index - The sequential parameter index
   * @returns The formatted parameter name (e.g., "p1", "p2")
   */
  private formatParameterName(index: number): string {
    return `p${index}`;
  }

  /**
   * Format parameter placeholder for SQL
   */
  public formatParameterPlaceholder(name: string): string {
    switch (this.dialect) {
      case SqlDialect.PostgreSQL:
        return `:${name}`;
      case SqlDialect.MySQL:
      case SqlDialect.SQLite:
        return `?`;
      case SqlDialect.MSSQL:
        return `@${name}`;
      default:
        return `:${name}`;
    }
  }

  /**
   * Serialize parameter value for SQL.
   * Normalizes undefined to null and handles Date, array, and object types.
   *
   * @param value - The value to serialize
   * @returns The serialized value suitable for SQL parameterization
   */
  public serializeParameter(value: any): any {
    // Normalize undefined to null
    if (value === undefined) {
      return null;
    }

    if (value === null) {
      return null;
    }

    // Handle dates (must come before object check)
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle arrays - keep as-is for PostgreSQL array/jsonb support
    if (Array.isArray(value)) {
      return value;
    }

    // Handle objects - keep as-is for PostgreSQL jsonb support
    // The database driver will handle JSON serialization
    if (typeof value === 'object') {
      return value;
    }

    return value;
  }

  /**
   * Deduplicate parameters with same value.
   * Uses JSON.stringify for deep comparison so objects and arrays
   * are correctly deduplicated (not just compared by reference).
   *
   * @param value - The parameter value to look for
   * @returns The existing parameter name if a duplicate is found, null otherwise
   */
  public deduplicateParameter(value: any): string | null {
    const serialized = JSON.stringify(this.serializeParameter(value));

    // Find existing parameter with same value using deep comparison
    for (const [name, paramValue] of this.parameters.entries()) {
      if (JSON.stringify(this.serializeParameter(paramValue)) === serialized) {
        return name;
      }
    }

    return null;
  }

  /**
   * Clone parameter manager
   */
  public clone(): ParameterManager {
    const cloned = new ParameterManager(this.dialect);
    cloned.parameterCount = this.parameterCount;
    cloned.parameters = new Map(this.parameters);
    return cloned;
  }
}

/**
 * Create a new parameter manager
 */
export function createParameterManager(dialect: SqlDialect = SqlDialect.PostgreSQL): ParameterManager {
  return new ParameterManager(dialect);
}
