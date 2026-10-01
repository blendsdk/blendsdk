# Contributing to BlendSDK

Thank you for your interest in contributing to BlendSDK! This guide will help you get started with development and submitting changes.

BlendSDK is an enterprise-grade TypeScript SDK providing libraries for web applications, database operations, caching, pub/sub messaging, email, internationalization, and code generation.

## Important: CI/CD Notice

This project's CI/CD runs on a private build server. When you submit a pull request, **automated tests will NOT run on your PR directly**. A maintainer will review your changes, run the test suite internally, and provide feedback.

**Please ensure your changes build and pass tests locally before submitting.**

## Development Setup

### Prerequisites

- **Node.js** >= 22.0.0
- **Yarn Classic** (1.22.x) — do not use Yarn 2+ or npm
- **Docker** (optional, for integration tests with PostgreSQL, Redis, and Mailpit)

### Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/blendsdk.git
   cd blendsdk
   ```
3. **Install dependencies:**
   ```bash
   yarn install
   ```
4. **Build all packages:**
   ```bash
   yarn build
   ```
5. **Run tests** (no Docker required):
   ```bash
   yarn test:fast
   ```

### Running Full Tests (with Docker)

Some packages require Docker for integration tests (PostgreSQL, Redis, Mailpit). To run the full test suite:

```bash
yarn test
```

Packages with Docker-based tests:
- `@blendsdk/postgresql` — PostgreSQL
- `@blendsdk/codegen` — PostgreSQL
- `@blendsdk/webafx` — PostgreSQL
- `@blendsdk/webafx-cache` — Redis
- `@blendsdk/webafx-mailer` — Mailpit (SMTP)

## Submitting Changes

### Workflow

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/my-feature
   ```
2. **Make your changes** — follow the code style guidelines below
3. **Build and test** locally:
   ```bash
   yarn build && yarn test:fast
   ```
4. **Commit** using conventional commit format (see below)
5. **Push** your branch and open a **Pull Request** against `main`

### Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what the PR does and why
- Add or update tests for any new functionality
- Ensure the build passes locally before submitting
- Reference any related issues in the PR description

## Commit Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Use the package name as the scope:

```
feat(stdlib): add new type guard for arrays
fix(postgresql): fix connection pool timeout handling
test(dbcore): add CRUD statement builder tests
docs(webafx): update API documentation
refactor(expression): simplify AST node creation
chore(monorepo): update development dependencies
```

### Commit Prefixes

| Prefix     | Usage                        |
| ---------- | ---------------------------- |
| `feat`     | New feature                  |
| `fix`      | Bug fix                      |
| `docs`     | Documentation only           |
| `refactor` | Code change without new feature or fix |
| `test`     | Adding or updating tests     |
| `chore`    | Build, config, tooling       |

### Valid Scopes

`stdlib`, `cmdline`, `expression`, `dbcore`, `postgresql`, `codegen`, `webafx`, `webafx-auth`, `webafx-cache`, `webafx-i18n`, `webafx-mailer`, `i18n`, `monorepo`

## Code Style

- **TypeScript** with strict mode enabled
- **ESM only** — use `import`/`export`, not `require`
- **Fluent API pattern** — builder methods return `this` for chaining
- **JSDoc comments** on all public and protected APIs
- **kebab-case** file names (e.g., `query-builder.ts`)
- **PascalCase** classes and types (e.g., `QueryBuilder`)
- **camelCase** functions and methods (e.g., `executeQuery`)

Format your code with Prettier before committing:
```bash
npx prettier --write "packages/**/*.ts"
```

## Reporting Issues

When filing an issue, please include:

1. **Description** — What happened vs. what you expected
2. **Steps to reproduce** — Minimal code or configuration to trigger the issue
3. **Environment** — Node.js version, OS, package version
4. **Error output** — Full error messages, stack traces, or logs

## Project Structure

```
packages/
├── stdlib/         # Foundation — type guards, utilities
├── cmdline/        # CLI argument parser
├── expression/     # SQL WHERE clause builder
├── dbcore/         # Database abstractions, CRUD builders
├── postgresql/     # PostgreSQL client + connection pooling
├── codegen/        # Code generators (TypeScript, Zod, OpenAPI, SQL)
├── webafx/         # Express 5 web framework with DI, plugins, routing
├── webafx-auth/    # Authentication plugin (JWT, OAuth2, OIDC)
├── webafx-cache/   # Caching + pub/sub (Redis and In-Memory)
├── webafx-i18n/    # i18n plugin for webafx
├── webafx-mailer/  # Email sending (SMTP and In-Memory)
└── i18n/           # Internationalization core
```

## License

By contributing to BlendSDK, you agree that your contributions will be licensed under the [MIT License](LICENSE).
