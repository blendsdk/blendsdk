/**
 * Loads and validates a `blendsdk.api.ts` contract file.
 *
 * The loader discovers the contract the way the migration config is discovered
 * (an explicit path, or a search upward for `blendsdk.api.ts`), loads it with
 * the same `jiti` TypeScript loader, validates every field, and returns the
 * contract with absolute artifact paths.
 *
 * @module
 */
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { configurationError } from './errors.js';
import type { ApiContract, ApiContractController, ResolvedApiContract } from './types.js';

/** Conventional configuration file name. */
export const API_CONFIG_FILENAME = 'blendsdk.api.ts';

/** Default committed OpenAPI document name. */
const DEFAULT_CONTRACT_FILE = 'api.json';

/** Top-level keys a contract may declare. */
const ALLOWED_KEYS = new Set(['outputDir', 'contractFile', 'controllers', 'openapi', 'generator']);

/** Generator flag keys a contract may declare. */
const ALLOWED_GENERATOR_KEYS = new Set(['splitByGroup', 'strict', 'clientName', 'runtimeImport']);

/** Options used to locate and load an API contract. */
export interface LoadApiContractOptions {
  /** Explicit configuration file or directory. */
  readonly configPath?: string;
  /** Directory from which conventional upward discovery begins. */
  readonly startDirectory?: string;
}

/**
 * Discovers, loads, and validates one API contract configuration.
 *
 * @param options - Optional explicit path or discovery starting point.
 * @returns Validated settings with absolute artifact paths.
 * @throws {ApiCliError} When discovery, loading, or validation fails (exit 2).
 */
export async function loadApiContract(
  options: LoadApiContractOptions
): Promise<ResolvedApiContract> {
  const configPath = await findApiConfig(options);
  const loaded = await importDefault(configPath);
  const contract = validateContract(loaded);
  const configDirectory = dirname(configPath);

  const outputDir = await resolveConfiguredPath(contract.outputDir, configDirectory, 'outputDir');
  const contractFile = await resolveConfiguredPath(
    contract.contractFile ?? DEFAULT_CONTRACT_FILE,
    configDirectory,
    'contractFile'
  );

  return {
    configPath,
    outputDir,
    contractFile,
    controllers: contract.controllers,
    openapi: contract.openapi,
    ...(contract.generator ? { generator: contract.generator } : {}),
  };
}

/**
 * Locates an explicit contract file or searches parent directories.
 *
 * @param options - The discovery options.
 * @returns The absolute configuration file path.
 * @throws {ApiCliError} When no configuration is found.
 */
async function findApiConfig(options: LoadApiContractOptions): Promise<string> {
  if (options.configPath) {
    const explicitPath = resolve(options.configPath);
    const kind = await pathKind(explicitPath);
    if (kind === 'file') {
      return explicitPath;
    }
    if (kind === 'directory') {
      return searchParents(explicitPath);
    }
    throw configurationError(`API configuration was not found at ${explicitPath}.`);
  }
  return searchParents(resolve(options.startDirectory ?? process.cwd()));
}

/**
 * Searches each parent directory once, stopping at the repository root.
 *
 * Discovery stops once a `.git` entry is seen, so a configuration file planted
 * above the project is never loaded.
 *
 * @param startDirectory - The directory to begin the search from.
 * @returns The first matching configuration file.
 * @throws {ApiCliError} When no configuration is found inside the project.
 */
async function searchParents(startDirectory: string): Promise<string> {
  let currentDirectory = startDirectory;
  while (true) {
    const candidate = resolve(currentDirectory, API_CONFIG_FILENAME);
    if ((await pathKind(candidate)) === 'file') {
      return candidate;
    }
    if (await hasGitEntry(currentDirectory)) {
      throw configurationError(`Could not find ${API_CONFIG_FILENAME} in this project.`);
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw configurationError(`Could not find ${API_CONFIG_FILENAME}.`);
    }
    currentDirectory = parentDirectory;
  }
}

/**
 * Reports whether a directory is a repository root.
 *
 * @param directory - The directory to inspect.
 * @returns True when a `.git` entry exists.
 */
async function hasGitEntry(directory: string): Promise<boolean> {
  return (await pathKind(resolve(directory, '.git'))) !== 'missing';
}

/**
 * Loads a module's default export with both Jiti caches disabled.
 *
 * @param path - The absolute configuration file path.
 * @returns The module's default export.
 * @throws {ApiCliError} When the module cannot be loaded.
 */
async function importDefault(path: string): Promise<unknown> {
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
    return await jiti.import(path, { default: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown loader failure';
    throw configurationError(`Could not load the API configuration: ${detail}`);
  }
}

/**
 * Validates the loaded value against the supported contract shape.
 *
 * @param value - The loaded default export.
 * @returns The validated contract.
 * @throws {ApiCliError} When the shape is invalid.
 */
function validateContract(value: unknown): ApiContract {
  if (!isRecord(value)) {
    throw configurationError('The API configuration must default-export an object.');
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw configurationError(`Unknown API configuration key: ${key}.`);
    }
  }

  const outputDir = requiredString(value, 'outputDir');
  const contractFile = optionalString(value, 'contractFile');
  const controllers = validateControllers(value.controllers);
  const openapi = validateOpenApi(value.openapi);
  const generator = validateGenerator(value.generator);

  return {
    outputDir,
    ...(contractFile ? { contractFile } : {}),
    controllers,
    openapi,
    ...(generator ? { generator } : {}),
  };
}

/**
 * Validates the controller registrations.
 *
 * @param value - The raw `controllers` value.
 * @returns The validated registrations.
 * @throws {ApiCliError} When the list or an entry is invalid.
 */
function validateControllers(value: unknown): ApiContractController[] {
  if (!Array.isArray(value)) {
    throw configurationError('The API configuration controllers must be an array.');
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw configurationError(`Controller ${index} must be an object.`);
    }
    const basePath = requiredString(entry, 'basePath');
    const controller = entry.controller;
    if (typeof controller !== 'function') {
      throw configurationError(`Controller ${index} must reference a controller class.`);
    }
    return { basePath, controller };
  });
}

/**
 * Validates the OpenAPI document configuration.
 *
 * Each known field is read and checked, and a fresh typed object is returned,
 * so an unexpected or malformed value never passes through unchecked.
 *
 * @param value - The raw `openapi` value.
 * @returns The validated configuration.
 * @throws {ApiCliError} When a field is missing or malformed.
 */
function validateOpenApi(value: unknown): ApiContract['openapi'] {
  if (!isRecord(value)) {
    throw configurationError('The API configuration openapi must be an object.');
  }
  const config: ApiContract['openapi'] = {
    title: requiredString(value, 'title'),
    version: requiredString(value, 'version'),
  };
  const description = optionalString(value, 'description');
  if (description) {
    config.description = description;
  }
  if (value.servers !== undefined) {
    config.servers = validateServers(value.servers);
  }
  if (value.securitySchemes !== undefined) {
    config.securitySchemes = validateSecuritySchemes(value.securitySchemes);
  }
  if (value.defaultSecurity !== undefined) {
    config.defaultSecurity = validateDefaultSecurity(value.defaultSecurity);
  }
  return config;
}

/**
 * Validates the optional server list.
 *
 * @param value - The raw `servers` value.
 * @returns The validated servers.
 * @throws {ApiCliError} When the list or an entry is malformed.
 */
function validateServers(value: unknown): NonNullable<ApiContract['openapi']['servers']> {
  if (!Array.isArray(value)) {
    throw configurationError('openapi.servers must be an array.');
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw configurationError(`openapi.servers[${index}] must be an object.`);
    }
    const description = optionalString(entry, 'description');
    return { url: requiredString(entry, 'url'), ...(description ? { description } : {}) };
  });
}

/**
 * Validates the optional security scheme map.
 *
 * @param value - The raw `securitySchemes` value.
 * @returns The validated schemes.
 * @throws {ApiCliError} When a scheme is malformed.
 */
function validateSecuritySchemes(
  value: unknown
): NonNullable<ApiContract['openapi']['securitySchemes']> {
  if (!isRecord(value)) {
    throw configurationError('openapi.securitySchemes must be an object.');
  }
  const schemes: NonNullable<ApiContract['openapi']['securitySchemes']> = {};
  for (const [name, scheme] of Object.entries(value)) {
    if (!isRecord(scheme)) {
      throw configurationError(`openapi.securitySchemes.${name} must be an object.`);
    }
    const type = scheme.type;
    if (type !== 'apiKey' && type !== 'http' && type !== 'oauth2' && type !== 'openIdConnect') {
      throw configurationError(`openapi.securitySchemes.${name}.type is not a valid scheme type.`);
    }
    const location = scheme.in;
    if (
      location !== undefined &&
      location !== 'query' &&
      location !== 'header' &&
      location !== 'cookie'
    ) {
      throw configurationError(`openapi.securitySchemes.${name}.in is not a valid location.`);
    }
    const description = optionalString(scheme, 'description');
    const schemeName = optionalString(scheme, 'name');
    const httpScheme = optionalString(scheme, 'scheme');
    const bearerFormat = optionalString(scheme, 'bearerFormat');
    schemes[name] = {
      type,
      ...(description ? { description } : {}),
      ...(schemeName ? { name: schemeName } : {}),
      ...(location ? { in: location } : {}),
      ...(httpScheme ? { scheme: httpScheme } : {}),
      ...(bearerFormat ? { bearerFormat } : {}),
    };
  }
  return schemes;
}

/**
 * Validates the optional default security requirements.
 *
 * @param value - The raw `defaultSecurity` value.
 * @returns The validated requirements.
 * @throws {ApiCliError} When an entry is malformed.
 */
function validateDefaultSecurity(
  value: unknown
): NonNullable<ApiContract['openapi']['defaultSecurity']> {
  if (!Array.isArray(value)) {
    throw configurationError('openapi.defaultSecurity must be an array.');
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw configurationError(`openapi.defaultSecurity[${index}] must be an object.`);
    }
    const requirement: Record<string, string[]> = {};
    for (const [name, scopes] of Object.entries(entry)) {
      if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string')) {
        throw configurationError(
          `openapi.defaultSecurity[${index}].${name} must be a string array.`
        );
      }
      requirement[name] = scopes;
    }
    return requirement;
  });
}

/**
 * Validates the optional generator flags.
 *
 * @param value - The raw `generator` value.
 * @returns The validated flags, or undefined.
 * @throws {ApiCliError} When a flag has the wrong type.
 */
function validateGenerator(value: unknown): ApiContract['generator'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw configurationError('The API configuration generator must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_GENERATOR_KEYS.has(key)) {
      throw configurationError(`Unknown generator option: ${key}.`);
    }
  }
  const generator: NonNullable<ApiContract['generator']> = {};
  if (value.splitByGroup !== undefined) {
    generator.splitByGroup = requiredBoolean(value, 'splitByGroup');
  }
  if (value.strict !== undefined) {
    generator.strict = requiredBoolean(value, 'strict');
  }
  if (value.clientName !== undefined) {
    generator.clientName = requiredString(value, 'clientName');
  }
  if (value.runtimeImport !== undefined) {
    generator.runtimeImport = requiredString(value, 'runtimeImport');
  }
  return generator;
}

/**
 * Resolves one configured artifact path.
 *
 * Relative paths are resolved against the configuration directory and must not
 * escape it. Absolute paths are treated as trusted, matching the migration
 * configuration loader; this is a developer-authored file, not untrusted input.
 *
 * @param configuredPath - The path from the configuration file.
 * @param configDirectory - The directory containing the configuration file.
 * @param field - The field name, for error messages.
 * @returns The absolute path.
 * @throws {ApiCliError} When the path is empty, escapes the directory, or is a root.
 */
async function resolveConfiguredPath(
  configuredPath: string,
  configDirectory: string,
  field: string
): Promise<string> {
  if (configuredPath.length === 0) {
    throw configurationError(`${field} must not be empty.`);
  }
  const absolutePath = resolve(configDirectory, configuredPath);
  if (!isAbsolute(configuredPath)) {
    const relativePath = relative(configDirectory, absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${separator()}`)) {
      throw configurationError(`${field} must not escape the configuration directory.`);
    }
  }
  if (absolutePath === parse(absolutePath).root) {
    throw configurationError(`${field} must not be a filesystem root.`);
  }
  return absolutePath;
}

/**
 * Returns the existing filesystem kind needed by deterministic discovery.
 *
 * @param path - The path to inspect.
 * @returns The filesystem kind.
 */
async function pathKind(path: string): Promise<'file' | 'directory' | 'missing'> {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * Reads a required non-empty string.
 *
 * @param record - The containing object.
 * @param key - The property name.
 * @returns The string value.
 * @throws {ApiCliError} When missing or not a non-empty string.
 */
function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`${key} must be a non-empty string.`);
  }
  return value;
}

/**
 * Reads an optional non-empty string.
 *
 * @param record - The containing object.
 * @param key - The property name.
 * @returns The string value, or undefined.
 * @throws {ApiCliError} When present but not a non-empty string.
 */
function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`${key} must be a non-empty string.`);
  }
  return value;
}

/**
 * Reads a required boolean.
 *
 * @param record - The containing object.
 * @param key - The property name.
 * @returns The boolean value.
 * @throws {ApiCliError} When not a boolean.
 */
function requiredBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw configurationError(`${key} must be a boolean.`);
  }
  return value;
}

/**
 * Narrows an unknown value to a plain key/value object.
 *
 * @param value - The value to inspect.
 * @returns True for a plain object.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Returns the platform path separator. */
function separator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
