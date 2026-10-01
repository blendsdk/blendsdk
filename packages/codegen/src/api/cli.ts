/**
 * The `blendsdk api` command line interface.
 *
 * Two commands back the drift gate. `generate` rebuilds the OpenAPI document
 * from the configured controllers, writes the contract JSON, and writes the
 * typed client. `check` performs the same rebuild without writing and fails
 * when either artifact differs from the committed one.
 *
 * The function never calls `process.exit`; it returns the process exit code and
 * writes through caller-provided output functions.
 *
 * @module
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  checkClient,
  formatOpenApiDocument,
  generateClient,
} from '../generator/client-generator.js';
import type { ClientGeneratorOptions, ContractIssue } from '../generator/client-types.js';
import { OpenAPIGenerator, type ControllerConstructor } from '../generator/openapi-generator.js';
import type { OpenAPIDocument } from '../generator/openapi-types.js';
import { loadApiContract } from './config.js';
import { ApiCliError } from './errors.js';
import type { ResolvedApiContract } from './types.js';

/** Process-independent output boundary for the API CLI. */
export interface ApiCliIo {
  /** Receives ordinary status and help text. */
  readonly stdout: (message: string) => void;
  /** Receives concise failures and drift reports. */
  readonly stderr: (message: string) => void;
}

/** The supported `blendsdk api` actions. */
type ApiAction = 'generate' | 'check';

/** A parsed `blendsdk api` invocation. */
interface ApiRoute {
  /** The selected action. */
  readonly action: ApiAction;
  /** An explicit configuration path, when supplied. */
  readonly configPath?: string;
}

/**
 * Runs one `blendsdk api` invocation and returns its process exit class.
 *
 * @param argv - Arguments after the executable name, starting with `api`.
 * @param io - Caller-owned output functions.
 * @returns `0` for success, `1` for drift or operational failure, `2` for usage
 *   or configuration failure.
 */
export async function main(argv: readonly string[], io: ApiCliIo): Promise<number> {
  if (isHelpRequest(argv)) {
    io.stdout(renderHelp());
    return 0;
  }

  const route = parseRoute(argv);
  if (!route) {
    io.stderr('USAGE: Run `blendsdk api --help` for the supported commands.');
    return 2;
  }

  try {
    const contract = await loadApiContract(
      route.configPath ? { configPath: route.configPath } : {}
    );
    const document = buildDocument(contract);
    if (route.action === 'generate') {
      await runGenerate(contract, document, io);
      return 0;
    }
    return await runCheck(contract, document, io);
  } catch (error) {
    if (error instanceof ApiCliError) {
      io.stderr(error.message);
      return error.exitCode;
    }
    io.stderr(error instanceof Error ? error.message : 'The API command failed unexpectedly.');
    return 1;
  }
}

/**
 * Rebuilds the document from the configured controllers.
 *
 * @param contract - The validated contract.
 * @returns The generated OpenAPI document.
 */
function buildDocument(contract: ResolvedApiContract): OpenAPIDocument {
  const generator = new OpenAPIGenerator(contract.openapi);
  for (const registration of contract.controllers) {
    if (!isControllerConstructor(registration.controller)) {
      throw new ApiCliError(
        `The controller for ${registration.basePath} is not a controller class.`,
        2
      );
    }
    generator.addController(registration.basePath, registration.controller);
  }
  return generator.generate();
}

/**
 * Narrows an unknown value to a controller constructor.
 *
 * @param value - The value to inspect.
 * @returns True when the value is a class (a function).
 */
function isControllerConstructor(value: unknown): value is ControllerConstructor {
  return typeof value === 'function';
}

/**
 * Writes the contract JSON and the generated client.
 *
 * @param contract - The validated contract.
 * @param document - The rebuilt document.
 * @param io - The output boundary.
 */
async function runGenerate(
  contract: ResolvedApiContract,
  document: OpenAPIDocument,
  io: ApiCliIo
): Promise<void> {
  const result = await generateClient(document, optionsFor(contract));
  const contractText = await formatOpenApiDocument(document);
  await mkdir(dirname(contract.contractFile), { recursive: true });
  await writeFile(contract.contractFile, contractText, 'utf8');
  reportIssues(result.issues, io);
  io.stdout(`GENERATED ${[...result.files, basename(contract.contractFile)].join(' ')}`);
}

/**
 * Rebuilds both artifacts in memory and reports drift.
 *
 * @param contract - The validated contract.
 * @param document - The rebuilt document.
 * @param io - The output boundary.
 * @returns `0` when clean, `1` when either artifact drifted or the contract has
 *   an error.
 */
async function runCheck(
  contract: ResolvedApiContract,
  document: OpenAPIDocument,
  io: ApiCliIo
): Promise<number> {
  const driftedFiles = new Set<string>();
  const contractText = await formatOpenApiDocument(document);
  if ((await readIfExists(contract.contractFile)) !== contractText) {
    driftedFiles.add(basename(contract.contractFile));
  }

  const result = await checkClient(document, optionsFor(contract));
  for (const name of result.driftedFiles ?? []) {
    driftedFiles.add(name);
  }
  reportIssues(result.issues, io);
  if (driftedFiles.size > 0) {
    io.stderr(`DRIFT: ${[...driftedFiles].sort().join(', ')}`);
  }
  const failed = driftedFiles.size > 0 || result.drifted === true;
  return failed ? 1 : 0;
}

/**
 * Builds the generator options from a resolved contract.
 *
 * @param contract - The validated contract.
 * @returns The generator options with the absolute output directory.
 */
function optionsFor(contract: ResolvedApiContract): ClientGeneratorOptions {
  return { outputDir: contract.outputDir, ...(contract.generator ?? {}) };
}

/**
 * Writes contract issues to the output boundary.
 *
 * @param issues - The issues to report.
 * @param io - The output boundary.
 */
function reportIssues(issues: readonly ContractIssue[], io: ApiCliIo): void {
  for (const issue of issues) {
    if (issue.severity === 'error') {
      io.stderr(`ERROR: ${issue.message}`);
    } else {
      io.stdout(`WARNING: ${issue.message}`);
    }
  }
}

/**
 * Parses the fixed `api <action> [--config <path>]` route.
 *
 * @param argv - The arguments after the executable name.
 * @returns The parsed route, or undefined for a usage error.
 */
function parseRoute(argv: readonly string[]): ApiRoute | undefined {
  if (argv[0] !== 'api') {
    return undefined;
  }
  const action = argv[1];
  if (action !== 'generate' && action !== 'check') {
    return undefined;
  }
  let configPath: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] !== '--config') {
      return undefined;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      return undefined;
    }
    configPath = value;
    index += 1;
  }
  return configPath ? { action, configPath } : { action };
}

/**
 * Recognizes the successful help forms.
 *
 * @param argv - The arguments after the executable name.
 * @returns True when help was requested.
 */
function isHelpRequest(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === 'api' && (argv[1] === '--help' || argv[1] === '-h');
}

/**
 * Renders the stable command list and exit classes.
 *
 * @returns The help text.
 */
function renderHelp(): string {
  return [
    'BlendSDK API client generation',
    '',
    'Usage: blendsdk api <generate|check> [--config <path>]',
    '',
    'Commands:',
    '  generate  Rebuild the document, write the contract JSON, then the client.',
    '  check     Rebuild in memory and fail on any drift from the committed artifacts.',
    '',
    'Exit codes: 0 success, 1 drift or operational failure, 2 usage or configuration failure.',
  ].join('\n');
}

/**
 * Reads a file when it exists.
 *
 * @param path - The file path.
 * @returns The file content, or undefined when it does not exist.
 */
async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
