/**
 * The public shape of a `blendsdk.api.ts` contract file.
 *
 * A project authors one default-exported contract with
 * {@link defineApiContract}. It names the controllers to collect, where to
 * write the OpenAPI document and the generated client, and the generator flags.
 *
 * @module
 */
import type { ClientGeneratorOptions } from '../generator/client-types.js';
import type { OpenAPIGeneratorConfig } from '../generator/openapi-types.js';

/**
 * One controller registration.
 */
export interface ApiContractController {
  /** The base path the controller is mounted at, for example `/api/products`. */
  basePath: string;
  /** The controller constructor. */
  controller: unknown;
}

/**
 * The configuration a `blendsdk.api.ts` file exports.
 *
 * @example
 * ```typescript
 * import { defineApiContract } from '@blendsdk/codegen';
 *
 * export default defineApiContract({
 *   outputDir: 'src/api-client',
 *   controllers: [{ basePath: '/api/products', controller: ProductsController }],
 *   openapi: { title: 'My API', version: '1.0.0' },
 * });
 * ```
 */
export interface ApiContract {
  /** Output directory for the generated client, resolved relative to the config file. */
  outputDir: string;
  /** OpenAPI JSON to write and compare, relative to the config file. Defaults to `api.json`. */
  contractFile?: string;
  /** Controllers to collect, with the base path each is mounted at. */
  controllers: ApiContractController[];
  /** OpenAPI document metadata and security schemes passed to the generator. */
  openapi: OpenAPIGeneratorConfig;
  /** Generator flags, excluding `outputDir` which is set above. */
  generator?: Omit<ClientGeneratorOptions, 'outputDir'>;
}

/**
 * Provides type inference for a contract configuration without changing it at
 * runtime.
 *
 * @param contract - The user-authored contract settings.
 * @returns The same contract object.
 */
export function defineApiContract(contract: ApiContract): ApiContract {
  return contract;
}

/**
 * A validated contract with absolute artifact paths.
 */
export interface ResolvedApiContract {
  /** Absolute path of the loaded configuration file. */
  configPath: string;
  /** Absolute output directory for generated files. */
  outputDir: string;
  /** Absolute path of the committed OpenAPI JSON document. */
  contractFile: string;
  /** The controller registrations. */
  controllers: ApiContractController[];
  /** The OpenAPI document metadata and security schemes. */
  openapi: OpenAPIGeneratorConfig;
  /** Generator flags, when configured. */
  generator?: Omit<ClientGeneratorOptions, 'outputDir'>;
}
