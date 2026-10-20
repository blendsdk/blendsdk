import { query, QueryBuilder } from '@blendsdk/expression';
import { Database } from './database.js';
import { DataServiceBase } from './dataservice-base.js';

/**
 * Function type for building query expressions with type-safe column references.
 * Accepts a QueryBuilder instance and configures the query conditions.
 *
 * @template T - The type representing the table/relation structure for type-safe column access
 * @export
 */
export type ExpressionBuilder<T = any> = (q: QueryBuilder<T>) => void;

/**
 * Promise type alias for a set of partial records from a relation.
 * Used as the return type for query methods that return multiple records.
 *
 * @template RecordType - The type of records in the result set
 * @export
 */
export type PromiseOfRecordSet<RecordType> = Promise<Partial<RecordType>[]>;

/**
 * Promise type alias for a single partial record from a relation.
 * Used as the return type for query methods that return a single record.
 *
 * @template RecordType - The type of the record to return
 * @export
 */
export type PromiseOfRecord<RecordType> = Promise<Partial<RecordType>>;

/**
 * Abstract base class for read-only data services that query a single database relation.
 * Provides common query patterns like findById, findByExpression, and findAll.
 *
 * Uses the expression builder from @blendsdk/expression for type-safe query construction
 * and delegates execution to the FromStatement builder.
 *
 * To create a concrete data service, either extend this class or use the
 * `createQueryService()` factory function.
 *
 * @export
 * @abstract
 * @class QueryDataService
 * @extends {DataServiceBase}
 * @template RelationType - The type representing the database relation/table structure
 *
 * @example
 * // Using the factory function
 * const UserService = createQueryService<User>('users', 'id');
 * const service = new UserService(db);
 * const user = await service.findById(123);
 *
 * @example
 * // Extending the class
 * class UserService extends QueryDataService<User> {
 *   constructor(db: Database) {
 *     super('users', 'id', db);
 *   }
 * }
 */
export abstract class QueryDataService<RelationType> extends DataServiceBase {
  /**
   * The name of the database relation (table or view) this service queries.
   *
   * @type {string}
   * @memberof QueryDataService
   */
  public relation: string;

  /**
   * The name of the primary key column used for findById queries.
   *
   * @type {string}
   * @memberof QueryDataService
   */
  public idColumn: string;

  /**
   * Creates an instance of QueryDataService.
   *
   * @param {string} relation - The name of the database relation (table/view) to query
   * @param {string} idColumn - The name of the primary key column
   * @param {Database} db - The database instance to execute queries against
   * @memberof QueryDataService
   */
  constructor(relation: string, idColumn: string, db: Database) {
    super(db);
    this.relation = relation;
    this.idColumn = idColumn;
  }

  /**
   * Finds a single record by its primary key value.
   * Constructs a WHERE clause matching the idColumn to the provided value.
   *
   * @template IdType - The type of the primary key value
   * @param {IdType} id - The primary key value to search for
   * @returns {PromiseOfRecord<RelationType | null>} The matching record, or null if not found
   * @memberof QueryDataService
   */
  findById<IdType>(id: IdType): PromiseOfRecord<RelationType | null> {
    const qb = query();
    qb.where(this.idColumn).equals(id);
    return this.db.from(this.relation).select().byExpression(qb.compile()).executeReturnSingle();
  }

  /**
   * Finds a single record matching a custom expression.
   * Returns the first matching record, or null if no records match.
   *
   * @param {ExpressionBuilder<RelationType>} builder - Expression builder function to construct the WHERE clause
   * @returns {PromiseOfRecord<RelationType | null>} The first matching record, or null if not found
   * @memberof QueryDataService
   *
   * @example
   * const user = await service.findByExpression(q =>
   *   q.where('email').equals('alice@example.com')
   * );
   */
  findByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecord<RelationType | null> {
    const qb = query<RelationType>();
    builder(qb);
    return this.db.from(this.relation).select().byExpression(qb.compile()).executeReturnSingle();
  }

  /**
   * Finds all records matching a custom expression.
   * Returns an empty array if no records match.
   *
   * @param {ExpressionBuilder<RelationType>} builder - Expression builder function to construct the WHERE clause
   * @returns {PromiseOfRecordSet<RelationType>} Array of matching records
   * @memberof QueryDataService
   *
   * @example
   * const activeUsers = await service.findAllByExpression(q =>
   *   q.where('active').equals(true)
   * );
   */
  findAllByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecordSet<RelationType> {
    const qb = query<RelationType>();
    builder(qb);
    return this.db.from(this.relation).select().byExpression(qb.compile()).executeReturnAll();
  }

  /**
   * Finds all records in the relation without any filtering.
   * Returns an empty array if the relation is empty.
   *
   * @returns {PromiseOfRecordSet<RelationType>} Array of all records in the relation
   * @memberof QueryDataService
   */
  findAll(): PromiseOfRecordSet<RelationType> {
    return this.db.from<RelationType>(this.relation).select().executeReturnAll();
  }
}

/**
 * Factory function that creates a concrete QueryDataService class for a specific relation.
 * The returned class can be instantiated with just a Database instance.
 *
 * @template RelationType - The type representing the relation/table structure
 * @param {string} relationName - The name of the relation/table
 * @param {string} idColumn - The name of the primary key column
 * @returns A concrete QueryDataService class bound to the specified relation
 *
 * @example
 * const UserService = createQueryService<User>('users', 'id');
 * const service = new UserService(db);
 * const user = await service.findById(123);
 */
export function createQueryService<RelationType>(
  relationName: string,
  idColumn: string
): new (db: Database) => QueryDataService<RelationType> {
  class ConcreteQueryDataService extends QueryDataService<RelationType> {
    constructor(db: Database) {
      super(relationName, idColumn, db);
    }
  }
  return ConcreteQueryDataService;
}
