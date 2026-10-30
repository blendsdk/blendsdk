import { Database } from './database.js';

/**
 * Abstract base class for data services.
 * Provides access to the database instance for subclasses to perform queries.
 *
 * @abstract
 * @class DataServiceBase
 */
export abstract class DataServiceBase {
  /**
   * The database instance used by this data service.
   * Protected to enforce encapsulation — subclasses should access it directly,
   * but external consumers should interact through the data service's public API.
   */
  protected db: Database;

  constructor(db: Database) {
    this.db = db;
  }
}
