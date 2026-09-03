/**
 * Assembly Export Verification Script
 *
 * Dynamically imports every blendsdk sub-module and verifies that key
 * named exports exist. Reports pass/fail per module with a clear summary.
 *
 * Some modules require peer dependencies (express, pg, ioredis, etc.).
 * For those, we catch import errors and report them separately.
 *
 * Usage:
 *   yarn build && yarn tsx scripts/verify-assembly-exports.ts
 *
 * Exit codes:
 *   0 — All verifiable modules pass
 *   1 — One or more modules failed
 *
 * @module verify-assembly-exports
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ============================================================================
// TYPES
// ============================================================================

interface ModuleCheck {
    /** Sub-module name (e.g., "stdlib", "webafx") */
    name: string;
    /** Import path relative to the blendsdk package */
    importPath: string;
    /** Named exports that must exist */
    expectedExports: string[];
    /** Whether this module requires peer dependencies that may not be installed */
    hasPeerDeps: boolean;
    /** Description of peer deps needed (for reporting) */
    peerDepsNote?: string;
}

interface CheckResult {
    name: string;
    status: 'pass' | 'fail' | 'skip';
    message: string;
    missingExports: string[];
}

// ============================================================================
// MODULE DEFINITIONS
// ============================================================================

const MODULES: ModuleCheck[] = [
    {
        name: 'stdlib',
        importPath: './dist/stdlib/index.js',
        expectedExports: [
            'isNullOrUndef',
            'isString',
            'isBoolean',
            'isNumeric',
            'formatString',
            'wrapInArray',
            'isTemplateString',
        ],
        hasPeerDeps: false,
    },
    {
        name: 'cmdline',
        importPath: './dist/cmdline/index.js',
        expectedExports: ['CommandLineParser'],
        hasPeerDeps: false,
    },
    {
        name: 'expression',
        importPath: './dist/expression/index.js',
        expectedExports: [
            'query',
            'QueryBuilderImpl',
            'PostgreSQLCompiler',
            'ParameterManager',
            'ASTNodeType',
            'ComparisonOperator',
            'LogicalOperator',
            'SqlDialect',
        ],
        hasPeerDeps: false,
    },
    {
        name: 'blendscript',
        importPath: './dist/blendscript/index.js',
        expectedExports: [
            'validateExpression',
            'compileExpression',
            'evaluateExpression',
            'BlendScriptApiError',
        ],
        hasPeerDeps: false,
    },
    {
        name: 'dbcore',
        importPath: './dist/dbcore/index.js',
        expectedExports: [
            'FromStatement',
            'InsertStatement',
            'UpdateStatement',
            'DeleteStatement',
            'Database',
        ],
        hasPeerDeps: false,
    },
    {
        name: 'i18n',
        importPath: './dist/i18n/index.js',
        expectedExports: ['Translator', 'mergeCatalogs'],
        hasPeerDeps: false,
    },
    {
        name: 'webafx',
        importPath: './dist/webafx/index.js',
        expectedExports: ['WebApplication', 'RouteBuilder', 'BaseController', 'ApplicationSettings'],
        hasPeerDeps: true,
        peerDepsNote: 'express, cors, helmet, cookie-parser',
    },
    {
        name: 'postgresql',
        importPath: './dist/postgresql/index.js',
        expectedExports: ['PostgreSQLDatabase'],
        hasPeerDeps: true,
        peerDepsNote: 'pg, yesql',
    },
    {
        name: 'webafx-cache',
        importPath: './dist/webafx-cache/index.js',
        expectedExports: [
            'CacheProvider',
            'PubSubProvider',
            'MemoryCacheProvider',
            'RedisCacheProvider',
            'MemoryPubSubProvider',
            'RedisPubSubProvider',
            'createCachePlugin',
            'createPubSubPlugin',
        ],
        hasPeerDeps: true,
        peerDepsNote: 'ioredis',
    },
    {
        name: 'webafx-mailer',
        importPath: './dist/webafx-mailer/index.js',
        expectedExports: [
            'MailProvider',
            'SmtpMailProvider',
            'MemoryMailProvider',
            'createMailPlugin',
        ],
        hasPeerDeps: true,
        peerDepsNote: 'nodemailer',
    },
    {
        name: 'webafx-mailer-azure',
        importPath: './dist/webafx-mailer-azure/index.js',
        expectedExports: ['AzureMailProvider', 'azureMailPlugin'],
        hasPeerDeps: true,
        peerDepsNote: '@azure/msal-node',
    },
    {
        name: 'webafx-auth',
        importPath: './dist/webafx-auth/index.js',
        expectedExports: ['AuthProvider', 'MemoryAuthProvider', 'JwtAuthProvider'],
        hasPeerDeps: true,
        peerDepsNote: 'jose',
    },
    {
        name: 'webafx-i18n',
        importPath: './dist/webafx-i18n/index.js',
        expectedExports: ['createI18nPlugin', 'resolveLocale', 'parseAcceptLanguage'],
        hasPeerDeps: true,
        peerDepsNote: 'pg (for PostgreSQLSource)',
    },
    {
        name: 'codegen',
        importPath: './dist/codegen/index.js',
        expectedExports: [],
        hasPeerDeps: true,
        peerDepsNote: 'pg, postgres-array',
    },
];

// ============================================================================
// VERIFICATION
// ============================================================================

/**
 * Verifies a single module by dynamically importing it and checking exports.
 */
async function verifyModule(mod: ModuleCheck, baseDir: string): Promise<CheckResult> {
    const fullPath = path.resolve(baseDir, mod.importPath);
    const fileUrl = pathToFileURL(fullPath).href;

    try {
        const exports = await import(fileUrl);
        const missingExports: string[] = [];

        for (const name of mod.expectedExports) {
            if (!(name in exports)) {
                missingExports.push(name);
            }
        }

        if (missingExports.length > 0) {
            return {
                name: mod.name,
                status: 'fail',
                message: `Missing exports: ${missingExports.join(', ')}`,
                missingExports,
            };
        }

        const exportCount = Object.keys(exports).filter(k => k !== '__esModule' && k !== 'default').length;
        return {
            name: mod.name,
            status: 'pass',
            message: `${mod.expectedExports.length} expected exports verified (${exportCount} total exports)`,
            missingExports: [],
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Check if this is a peer dependency issue
        if (mod.hasPeerDeps && (message.includes('Cannot find module') || message.includes('Cannot find package'))) {
            return {
                name: mod.name,
                status: 'skip',
                message: `Skipped — peer deps not installed (needs: ${mod.peerDepsNote})`,
                missingExports: [],
            };
        }

        return {
            name: mod.name,
            status: 'fail',
            message: `Import error: ${message}`,
            missingExports: [],
        };
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    const baseDir = path.resolve(process.cwd(), 'packages/blendsdk');

    console.log('🔍 BlendSDK Assembly Export Verification');
    console.log(`   Base: ${baseDir}`);
    console.log(`   Modules: ${MODULES.length}`);
    console.log('');

    const results: CheckResult[] = [];

    for (const mod of MODULES) {
        const result = await verifyModule(mod, baseDir);
        results.push(result);

        const icon = result.status === 'pass' ? '✅' : result.status === 'skip' ? '⏭️ ' : '❌';
        console.log(`  ${icon} ${mod.name.padEnd(16)} ${result.message}`);
    }

    console.log('');

    // Summary
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const skipped = results.filter(r => r.status === 'skip').length;

    console.log('━'.repeat(60));
    console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('━'.repeat(60));

    if (failed > 0) {
        console.log('');
        console.log('❌ FAILED modules:');
        for (const r of results.filter(r => r.status === 'fail')) {
            console.log(`   • ${r.name}: ${r.message}`);
        }
        process.exit(1);
    }

    if (skipped > 0) {
        console.log('');
        console.log('ℹ️  Skipped modules (peer deps not installed — this is normal in dev):');
        for (const r of results.filter(r => r.status === 'skip')) {
            console.log(`   • ${r.name}: ${r.message}`);
        }
    }

    console.log('');
    console.log('✅ Assembly verification complete!');
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Unexpected error: ${message}`);
    process.exit(1);
});
