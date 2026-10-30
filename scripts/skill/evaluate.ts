/**
 * Skill-versus-MCP evaluation harness.
 *
 * Runs a fixed set of prompts against two context arms:
 *
 * - **skill** — the references shipped in `.agents/skills/blendsdk`
 * - **mcp** — the retired documentation recovered from git at `55c910f34`
 *
 * Each answer is graded deterministically: every TypeScript block must resolve
 * against the real SDK (no missing package, symbol, or member) and must not use
 * private `@blendsdk/` imports. Raw answers and the comparison table are written
 * to an ignored cache directory for the rubric review.
 *
 * The harness is a one-time evidence exercise, not a CI gate.
 *
 * @module skill/evaluate
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { LLMResult } from '../changelog/llm-provider.js';

import { createLLMConfig, LLMProvider } from '../changelog/llm-provider.js';

import { checkSemantics } from './semantic-check.js';

import type { SemanticBlock } from './semantic-check.js';

/** Commit that still contains the retired MCP documentation. */
const MCP_COMMIT = '55c910f34';

/** Output token limit for each evaluation call. */
const MAX_OUTPUT_TOKENS = 131_072;

/** Timeout for each evaluation call. */
const REQUEST_TIMEOUT_MS = 600_000;

/**
 * Maximum context characters per arm.
 *
 * Both arms are capped at the same size so the comparison is fair and the
 * prompt stays inside the model's context window.
 */
const MAX_CONTEXT_CHARS = 100_000;

/**
 * Truncates context to the shared cap.
 *
 * @param text - Context text
 * @returns The text, or its capped prefix with a marker
 */
function capContext(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[context truncated]`;
}

/** One evaluation prompt and the context both arms must supply. */
interface EvalPrompt {
  /** Stable identifier. */
  id: string;

  /** Short topic used in the results table. */
  topic: string;

  /** Package whose skill references are used for the skill arm. */
  packageName: string;

  /** Skill pattern reference, when one exists. */
  skillPattern?: string;

  /** Package documentation file for the MCP arm. */
  mcpPackageDoc: string;

  /** Pattern documentation file for the MCP arm, when one exists. */
  mcpPatternDoc?: string;

  /** The user request. */
  request: string;
}

/** The ten evaluation prompts. */
const EVAL_PROMPTS: EvalPrompt[] = [
  {
    id: 'crud-api',
    topic: 'CRUD API',
    packageName: 'dbcore',
    skillPattern: '01-web-api-crud.md',
    mcpPackageDoc: '02-packages/dbcore.md',
    mcpPatternDoc: '03-patterns/01-web-api-crud.md',
    request:
      'Write a complete TypeScript example that defines a CRUD API with BlendSDK and exposes it over HTTP.',
  },
  {
    id: 'jwt-auth',
    topic: 'JWT auth',
    packageName: 'webafx-auth',
    skillPattern: '02-authentication-jwt.md',
    mcpPackageDoc: '02-packages/webafx-auth.md',
    mcpPatternDoc: '03-patterns/02-authentication-jwt.md',
    request:
      'Write a complete TypeScript example that adds JWT authentication to a BlendSDK application.',
  },
  {
    id: 'caching',
    topic: 'Caching and pub/sub',
    packageName: 'webafx-cache',
    skillPattern: '03-caching-patterns.md',
    mcpPackageDoc: '02-packages/webafx-cache.md',
    mcpPatternDoc: '03-patterns/03-caching-patterns.md',
    request:
      'Write a complete TypeScript example that adds caching and publish/subscribe to a BlendSDK application.',
  },
  {
    id: 'db-queries',
    topic: 'Database queries',
    packageName: 'expression',
    skillPattern: '04-database-queries.md',
    mcpPackageDoc: '02-packages/expression.md',
    mcpPatternDoc: '03-patterns/04-database-queries.md',
    request:
      'Write a complete TypeScript example that builds and compiles a database query with BlendSDK.',
  },
  {
    id: 'codegen',
    topic: 'Codegen from schema',
    packageName: 'codegen',
    skillPattern: '06-code-generation.md',
    mcpPackageDoc: '02-packages/codegen.md',
    mcpPatternDoc: '03-patterns/06-code-generation.md',
    request:
      'Write a complete TypeScript example that generates TypeScript types from a database schema with BlendSDK.',
  },
  {
    id: 'email',
    topic: 'Email sending',
    packageName: 'webafx-mailer',
    skillPattern: '07-email-sending.md',
    mcpPackageDoc: '02-packages/webafx-mailer.md',
    mcpPatternDoc: '03-patterns/07-email-sending.md',
    request: 'Write a complete TypeScript example that sends an email with BlendSDK.',
  },
  {
    id: 'i18n',
    topic: 'Internationalization',
    packageName: 'webafx-i18n',
    skillPattern: '08-internationalization.md',
    mcpPackageDoc: '02-packages/webafx-i18n.md',
    mcpPatternDoc: '03-patterns/08-internationalization.md',
    request:
      'Write a complete TypeScript example that adds internationalization to a BlendSDK application.',
  },
  {
    id: 'logging',
    topic: 'Structured logging',
    packageName: 'webafx-pino',
    mcpPackageDoc: '02-packages/webafx-pino.md',
    request:
      'Write a complete TypeScript example that adds structured logging to a BlendSDK application.',
  },
  {
    id: 'react',
    topic: 'React hooks',
    packageName: 'react',
    mcpPackageDoc: '02-packages/react.md',
    request:
      'Write a complete TypeScript React example that fetches data from a BlendSDK API using the SDK React hooks.',
  },
  {
    id: 'testing',
    topic: 'Testing patterns',
    packageName: 'stdlib',
    skillPattern: '09-testing-patterns.md',
    mcpPackageDoc: '02-packages/stdlib.md',
    mcpPatternDoc: '03-patterns/09-testing-patterns.md',
    request:
      'Write a complete TypeScript example that tests a BlendSDK feature with a real assertion.',
  },
];

/** Deterministic grade for one answer. */
interface Grade {
  /** Number of TypeScript blocks found. */
  blocks: number;

  /** Import or symbol problems against the public SDK. */
  importProblems: number;

  /** Member-level problems, reported for the rubric but not gated. */
  memberProblems: number;

  /** True when a private `@blendsdk/` import was used. */
  privateImport: boolean;

  /** True when the answer passes every deterministic check. */
  pass: boolean;
}

/**
 * Diagnostic codes that mean the answer imported the wrong thing.
 *
 * Member problems (2339/2551) are excluded: in a snippet the type may be
 * `unknown` or come from the answer's own files, so they cannot be attributed
 * to the SDK reliably. They are counted separately for the rubric.
 */
const IMPORT_DIAGNOSTIC_CODES = new Set([2305, 2459, 2497, 2614, 2724, 2503]);

/** Diagnostic codes that report a missing member. */
const MEMBER_DIAGNOSTIC_CODES = new Set([2339, 2551, 2561]);

/** One row of the results table. */
interface EvalRow {
  /** Prompt id. */
  id: string;

  /** Prompt topic. */
  topic: string;

  /** Arm name. */
  arm: string;

  /** Deterministic grade. */
  grade: Grade;

  /** Input tokens used. */
  inputTokens: number;

  /** Output tokens used. */
  outputTokens: number;
}

/** Matches a TypeScript fenced block. */
const FENCE_RE = /```(?:ts|typescript|tsx)\b[^\n]*\n([\s\S]*?)```/g;

/**
 * Extracts the TypeScript blocks from an answer.
 *
 * @param markdown - Model answer
 * @returns Block bodies as semantic-check inputs
 */
function extractBlocks(markdown: string): SemanticBlock[] {
  const blocks: SemanticBlock[] = [];
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(markdown)) !== null) {
    blocks.push({ reference: `answer:${blocks.length}`, startLine: 1, code: match[1] });
  }
  return blocks;
}

/**
 * Grades one answer with the deterministic checks.
 *
 * @param rootDir - Absolute path to the repository root
 * @param markdown - Model answer
 * @returns The deterministic grade
 */
function grade(rootDir: string, markdown: string): Grade {
  const blocks = extractBlocks(markdown);
  const problems = checkSemantics(rootDir, blocks).filter(p => p.tier === 'api');
  const importProblems = problems.filter(
    p =>
      IMPORT_DIAGNOSTIC_CODES.has(p.code) || (p.code === 2307 && /['"]@?blendsdk\//.test(p.message))
  ).length;
  const memberProblems = problems.filter(p => MEMBER_DIAGNOSTIC_CODES.has(p.code)).length;
  const privateImport = /from\s*['"]@blendsdk\//.test(markdown);
  return {
    blocks: blocks.length,
    importProblems,
    memberProblems,
    privateImport,
    pass: blocks.length > 0 && importProblems === 0 && !privateImport,
  };
}

/**
 * Reads and concatenates files, skipping missing ones.
 *
 * @param paths - Absolute file paths
 * @returns Combined content
 */
function readAll(paths: string[]): string {
  return paths
    .filter(file => fs.existsSync(file))
    .map(file => fs.readFileSync(file, 'utf-8'))
    .join('\n\n---\n\n');
}

/**
 * Assembles the skill arm context for one prompt.
 *
 * @param rootDir - Absolute path to the repository root
 * @param prompt - Evaluation prompt
 * @returns Concatenated reference content
 */
function skillContext(rootDir: string, prompt: EvalPrompt): string {
  const packageDir = path.join(
    rootDir,
    '.agents',
    'skills',
    'blendsdk',
    'references',
    'packages',
    prompt.packageName
  );
  const files = ['overview.md', 'usage.md', 'recipes.md', 'api.md', 'pitfalls.md'].map(name =>
    path.join(packageDir, name)
  );
  if (prompt.skillPattern) {
    files.push(
      path.join(
        rootDir,
        '.agents',
        'skills',
        'blendsdk',
        'references',
        'patterns',
        prompt.skillPattern
      )
    );
  }
  return readAll(files);
}

/**
 * Recovers one MCP documentation file from the retirement commit.
 *
 * @param rootDir - Absolute path to the repository root
 * @param relative - Path relative to `packages/blendsdk-mcp/docs`
 * @returns File content, or empty string when the file is absent
 */
function recoverMcpDoc(rootDir: string, relative: string): string {
  const result = spawnSync(
    'git',
    ['show', `${MCP_COMMIT}:packages/blendsdk-mcp/docs/${relative}`],
    { cwd: rootDir, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }
  );
  return result.status === 0 ? result.stdout : '';
}

/**
 * Assembles the MCP arm context for one prompt.
 *
 * @param rootDir - Absolute path to the repository root
 * @param prompt - Evaluation prompt
 * @returns Concatenated documentation content
 */
function mcpContext(rootDir: string, prompt: EvalPrompt): string {
  const parts = [recoverMcpDoc(rootDir, prompt.mcpPackageDoc)];
  if (prompt.mcpPatternDoc) {
    parts.push(recoverMcpDoc(rootDir, prompt.mcpPatternDoc));
  }
  return parts.filter(part => part.length > 0).join('\n\n---\n\n');
}

/**
 * Builds the fixed system and user prompts for one evaluation call.
 *
 * @param arm - Arm name
 * @param prompt - Evaluation prompt
 * @param context - Arm context
 * @returns System and user prompts
 */
function buildMessages(
  arm: string,
  prompt: EvalPrompt,
  context: string
): { system: string; user: string } {
  return {
    system: [
      'You are a BlendSDK expert.',
      'Answer with TypeScript code that uses only the public SDK.',
      'Import from the public package paths such as `blendsdk/dbcore`; never import from `@blendsdk/*`.',
      'Do not invent APIs; use only what the context provides.',
    ].join(' '),
    user: [`Task: ${prompt.request}`, '', `Reference material (${arm}):`, context].join('\n'),
  };
}

/**
 * Runs the evaluation harness.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : EVAL_PROMPTS.length;
  const dryRun = args.includes('--dry-run');

  const rootDir = process.cwd();
  const outRoot = path.join(rootDir, 'node_modules', '.cache', 'skill-eval');
  const provider = new LLMProvider(createLLMConfig('deepseek'));
  const rows: EvalRow[] = [];

  for (const prompt of EVAL_PROMPTS.slice(0, limit)) {
    for (const arm of ['skill', 'mcp']) {
      const context =
        arm === 'skill'
          ? capContext(skillContext(rootDir, prompt))
          : capContext(mcpContext(rootDir, prompt));
      if (dryRun) {
        console.log(`${prompt.id}/${arm}: ${context.length} context chars`);
        continue;
      }

      const messages = buildMessages(arm, prompt, context);
      process.stdout.write(`▶ ${prompt.id}/${arm} (${context.length} chars)...`);
      let result: LLMResult | null = null;
      try {
        result = await provider.generate(messages.system, messages.user, {
          maxTokens: MAX_OUTPUT_TOKENS,
          timeout: REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        console.log(` ❌ ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!result) {
        console.log(' ❌ no result');
        continue;
      }

      const armDir = path.join(outRoot, arm);
      fs.mkdirSync(armDir, { recursive: true });
      fs.writeFileSync(path.join(armDir, `${prompt.id}.md`), result.content, 'utf-8');

      const graded = grade(rootDir, result.content);
      rows.push({
        id: prompt.id,
        topic: prompt.topic,
        arm,
        grade: graded,
        inputTokens: result.tokensUsed.input,
        outputTokens: result.tokensUsed.output,
      });
      console.log(
        ` ${graded.pass ? '✅' : '❌'} ${graded.blocks} blocks, ${graded.importProblems} import problems, ` +
          `${graded.memberProblems} member problems${graded.privateImport ? ', private import' : ''}`
      );
    }
  }

  if (dryRun) {
    return;
  }

  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(
    path.join(outRoot, 'results.json'),
    JSON.stringify(rows, null, 2) + '\n',
    'utf-8'
  );

  const lines = [
    '| Prompt | Skill pass | MCP pass | Skill import problems | MCP import problems | Skill member problems | MCP member problems |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const prompt of EVAL_PROMPTS.slice(0, limit)) {
    const skill = rows.find(r => r.id === prompt.id && r.arm === 'skill');
    const mcp = rows.find(r => r.id === prompt.id && r.arm === 'mcp');
    lines.push(
      `| ${prompt.topic} | ${skill?.grade.pass ? 'yes' : 'no'} | ${mcp?.grade.pass ? 'yes' : 'no'} ` +
        `| ${skill?.grade.importProblems ?? '-'} | ${mcp?.grade.importProblems ?? '-'} ` +
        `| ${skill?.grade.memberProblems ?? '-'} | ${mcp?.grade.memberProblems ?? '-'} |`
    );
  }
  const table = lines.join('\n');
  fs.writeFileSync(path.join(outRoot, 'results.md'), table + '\n', 'utf-8');

  const skillPass = rows.filter(r => r.arm === 'skill' && r.grade.pass).length;
  const mcpPass = rows.filter(r => r.arm === 'mcp' && r.grade.pass).length;
  console.log(`\n${table}\n`);
  console.log(`Skill arm: ${skillPass}/${limit} pass. MCP arm: ${mcpPass}/${limit} pass.`);
  console.log(`Raw answers and results.json in ${outRoot}`);
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (scriptPath === modulePath) {
  main().catch(error => {
    console.error(
      `💥 Evaluation failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
