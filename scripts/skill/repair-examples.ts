/**
 * Local repair command.
 *
 * Reads a validator report (or runs the validator) and asks the language model
 * to fix the failing example blocks in place. This is an authoring tool: it is
 * never part of CI, and it refuses to run when a `CI` environment variable is
 * set.
 *
 * Usage:
 * ```bash
 * yarn skill:repair --report node_modules/.cache/skill-validate/report.json
 * yarn skill:repair --filter references/packages/expression
 * ```
 *
 * @module skill/repair-examples
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createLLMConfig, LLMProvider } from '../changelog/llm-provider.js';

import { repairExamples } from './repair.js';
import { formatProblem, validateExamples } from './validate-examples.js';

import type { ValidationReport } from './validate-examples.js';

/** Default report location written by the validator. */
const DEFAULT_REPORT = path.join('node_modules', '.cache', 'skill-validate', 'report.json');

/** Output token limit for each repair call. */
const MAX_OUTPUT_TOKENS = 131_072;

/** Timeout for each repair call. */
const REQUEST_TIMEOUT_MS = 600_000;

/** Parsed command-line options. */
interface CliOptions {
  /** Path to a report JSON, when provided. */
  report?: string;

  /** Maximum repair rounds. */
  maxRounds?: number;

  /** Validation filter path. */
  filter?: string;

  /** Maximum number of blocks to repair. */
  limit?: number;

  /** Print the work list without calling the model. */
  dryRun: boolean;

  /** Allow running under a `CI` environment variable. */
  allowCi: boolean;
}

/**
 * Parses the command-line arguments.
 *
 * @param argv - Arguments after the script name
 * @returns Parsed options
 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, allowCi: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report' && i + 1 < argv.length) {
      options.report = argv[++i];
    } else if (arg === '--max-rounds' && i + 1 < argv.length) {
      options.maxRounds = Number(argv[++i]);
    } else if (arg === '--filter' && i + 1 < argv.length) {
      options.filter = argv[++i];
    } else if (arg === '--limit' && i + 1 < argv.length) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--allow-ci') {
      options.allowCi = true;
    }
  }

  return options;
}

/**
 * Loads a validation report from a `--report` file.
 *
 * @param reportPath - Path to the serialized report
 * @param rootDir - Absolute path to the repository root
 * @returns A validation report
 */
function readReport(reportPath: string, rootDir: string): ValidationReport {
  const absolute = path.resolve(rootDir, reportPath);
  const parsed: unknown = JSON.parse(fs.readFileSync(absolute, 'utf-8'));
  const problems =
    typeof parsed === 'object' && parsed !== null && 'problems' in parsed
      ? (parsed as { problems: ValidationReport['details'] }).problems
      : [];

  return {
    ok: problems.length === 0,
    problems: problems.map(formatProblem),
    details: problems,
    filesScanned: 0,
    blocksChecked: 0,
    fragmentsSkipped: 0,
    contextualSkipped: 0,
    counterExamplesSkipped: 0,
  };
}

/**
 * Runs the repair command.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (process.env.CI && !options.allowCi) {
    console.error('Refusing to run the repair tool in CI. Use --allow-ci to override.');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const report = options.report
    ? readReport(options.report, rootDir)
    : validateExamples(rootDir, { filter: options.filter });

  if (report.details.length === 0) {
    console.log('✅ Nothing to repair.');
    return;
  }

  console.log(`🛠️  ${report.details.length} problem(s) to repair:`);
  for (const problem of report.details) {
    console.log(`   - ${formatProblem(problem)}`);
  }

  if (options.dryRun) {
    console.log('ℹ️  Dry run: no changes made.');
    return;
  }

  const provider = new LLMProvider(createLLMConfig());
  const result = await repairExamples(
    { rootDir, report, maxRounds: options.maxRounds, limit: options.limit },
    {
      generate: async (system, user) => {
        const response = await provider.generate(system, user, {
          maxTokens: MAX_OUTPUT_TOKENS,
          timeout: REQUEST_TIMEOUT_MS,
        });
        return response?.content ?? null;
      },
    }
  );

  console.log(
    `\n🛠️  ${result.rounds} round(s): ${result.fixed} fixed, ${result.remaining} remaining.`
  );
  if (result.remaining > 0) {
    console.log('Re-run `yarn skill:validate` to see the remaining problems.');
    process.exitCode = 1;
  }
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (scriptPath === modulePath) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`💥 Repair failed: ${message}`);
    process.exit(1);
  });
}
