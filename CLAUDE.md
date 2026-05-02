# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Twenty is an open-source CRM built with modern technologies in a monorepo structure. The codebase is organized as an Nx workspace with multiple packages.

Toolchain: **Node ≥ 24.5**, **Yarn 4** (`packageManager: yarn@4.13.0`), Nx 22, TypeScript 5.9. `npm` is rejected by the engines field — always use `yarn` / `npx nx`.

## Key Commands

### Development
```bash
# Start development environment (frontend + backend + worker)
yarn start

# Individual package development
npx nx start twenty-front     # Start frontend dev server
npx nx start twenty-server    # Start backend server
npx nx run twenty-server:worker  # Start background worker
```

### Testing
```bash
# Preferred: run a single test file (fast)
# twenty-front uses jest.config.mjs; twenty-server uses jest.config.ts — pass the right one
npx jest path/to/test.test.ts --config=packages/twenty-front/jest.config.mjs
npx jest path/to/test.test.ts --config=packages/twenty-server/jest.config.ts

# Run all tests for a package
npx nx test twenty-front      # Frontend unit tests
npx nx test twenty-server     # Backend unit tests
npx nx run twenty-server:test:integration:with-db-reset  # Integration tests with DB reset
# To run an individual test or a pattern of tests:
cd packages/{workspace} && npx jest "pattern or filename"

# Storybook
npx nx storybook:build twenty-front
npx nx storybook:test twenty-front

# When testing the UI end to end, click on "Continue with Email" and use the prefilled credentials.
```

### Code Quality
```bash
# Linting (diff with main - fastest, always prefer this)
npx nx lint:diff-with-main twenty-front
npx nx lint:diff-with-main twenty-server
npx nx lint:diff-with-main twenty-front --configuration=fix  # Auto-fix

# Linting (full project - slower, use only when needed)
npx nx lint twenty-front
npx nx lint twenty-server

# Type checking
npx nx typecheck twenty-front
npx nx typecheck twenty-server

# Format code
npx nx fmt twenty-front
npx nx fmt twenty-server
```

### Build
```bash
# Build packages (twenty-shared must be built first)
npx nx build twenty-shared
npx nx build twenty-front
npx nx build twenty-server
```

### Database Operations
```bash
# Database management
npx nx database:reset twenty-server         # Reset database
npx nx run twenty-server:database:init:prod # Initialize database

# Run upgrade: fast instance commands first, then slow ones (only with --include-slow),
# then workspace commands. Each group is timestamp-sorted internally.
npx nx run twenty-server:database:migrate:prod

# Generate an instance command (fast or slow)
npx nx run twenty-server:database:migrate:generate --name <name> --type <fast|slow>
```

### MCP Servers

Three MCP servers are configured in `.mcp.json`:
- **postgres** — read-only Postgres connection. Use it to inspect workspace data and metadata, verify migration results (columns, types, constraints), explore the multi-tenant schema structure (core, metadata, workspace-specific schemas), and confirm whether a bug is frontend, backend, or data-level. Read-only — for writes (reset, migrations, sync), use the CLI commands above.
- **playwright** — headless browser for end-to-end UI verification. Use it to exercise flows ("Continue with Email" + prefilled credentials) before reporting UI work as complete.
- **context7** — library/API documentation lookup. Use proactively for code generation, setup/configuration steps, or anything involving an external library — resolve the library ID and fetch docs without waiting for an explicit request.

### GraphQL
```bash
# Generate GraphQL types (run after schema changes)
npx nx run twenty-front:graphql:generate
npx nx run twenty-front:graphql:generate --configuration=metadata
```

## Architecture Overview

### Tech Stack
- **Frontend**: React 18, TypeScript, Jotai (state management), Linaria (styling), Vite
- **Backend**: NestJS, TypeORM, PostgreSQL, Redis, GraphQL (with GraphQL Yoga)
- **Monorepo**: Nx workspace managed with Yarn 4

### Package Structure (non-exhaustive — see `packages/` for the full list)
```
packages/
├── twenty-front/          # React frontend application
├── twenty-server/         # NestJS backend API
├── twenty-ui/             # Shared UI components library
├── twenty-shared/         # Common types and utilities
├── twenty-emails/         # Email templates with React Email
├── twenty-website/        # Next.js documentation website
├── twenty-zapier/         # Zapier integration
├── twenty-e2e-testing/    # Playwright E2E tests
├── twenty-cli/            # CLI tool
├── twenty-sdk/            # SDK
├── twenty-client-sdk/     # Client SDK
├── twenty-apps/           # First-party apps
├── twenty-docker/         # Docker configs (incl. dev compose)
├── twenty-mcp/            # External MCP proxy — READ packages/twenty-mcp/CLAUDE.md BEFORE editing
└── twenty-utils/          # Repo utilities (incl. setup-dev-env.sh)
```

### Package-level `CLAUDE.md` files take precedence

When working inside a package directory, **the package's own `CLAUDE.md` (if present) overrides and extends repo-level guidance** for that package. Read it first.

- [`packages/twenty-mcp/CLAUDE.md`](packages/twenty-mcp/CLAUDE.md) — **REQUIRED reading before editing `packages/twenty-mcp/`**. Contains: architecture invariants (3 transports, /metadata vs /graphql), the **Evaluation rules** (R1–R5: how "done" is defined; the framework that prevents the bug class that has cost ~1.1M+ tokens to date), the **Flawed framings catalog** (six wrong frames that produced production bugs — recognize them in flight), the **before-shipping checklist** with mechanical + evaluation gates, and pointers to the audit retrospectives. None of this is optional. The structural defenses (coverage tests, capture scripts, integration sweep) only work if the rules in that file are followed.

If you are about to ship a wrapper / proxy / adapter in any other package, **read `packages/twenty-mcp/CLAUDE.md` anyway** — the rules are wrapper-class generalities, not Twenty-specific.

### Code Conventions
Full rules live in `.cursor/rules/` (`code-style.mdc`, `file-structure.mdc`, `typescript-guidelines.mdc`, `react-general-guidelines.mdc`) and are auto-applied — read them when in doubt. The non-negotiables to know up front:

- **No `any`** — strict TypeScript, `noImplicitAny` enabled.
- **`type`, not `interface`** (except when extending third-party interfaces).
- **String literal unions, not enums** (except GraphQL).
- **Named exports only** — no default exports.
- **Functional components only** — no classes.
- **kebab-case** for files and directories; `*.component.tsx`, `*.styles.ts`, `*.test.tsx`, `*.service.ts`, `*.entity.ts`, `*.dto.ts` suffixes.
- **No abbreviations** in variable names (`user`, not `u`; `fieldMetadataItem`, not `f`).
- **Event handlers over `useEffect`** for state updates.
- Comments: only when explaining non-obvious *why*, never JSDoc blocks. Use `//` form.

Caveat: `.cursor/rules/translations.mdc` references **react-i18next**, but the codebase actually uses **Lingui** (`@lingui/react`). Trust Lingui. Likewise `.cursor/rules/architecture.mdc` says "Styled Components" — the codebase uses **Linaria**.

### State Management
- **Jotai** for global state: atoms for primitive state, selectors for derived state, atom families for dynamic collections
- Component-specific state with React hooks (`useState`, `useReducer` for complex logic)
- GraphQL cache managed by Apollo Client
- Use functional state updates: `setState(prev => prev + 1)`

### Backend Architecture
- **NestJS modules** for feature organization
- **TypeORM** for database ORM with PostgreSQL
- **GraphQL** API with code-first approach
- **Redis** for caching and session management
- **BullMQ** for background job processing

### Database & Upgrade Commands
- **PostgreSQL** as primary database
- **Redis** for caching and sessions
- **ClickHouse** for analytics (when enabled)
- When changing entity files, generate an **instance command** (`database:migrate:generate --name <name> --type <fast|slow>`)
- **Fast** instance commands handle schema changes; **slow** ones add a `runDataMigration` step for data backfills
- **Workspace commands** iterate over all active/suspended workspaces for per-workspace upgrades
- Commands use `@RegisteredInstanceCommand` and `@RegisteredWorkspaceCommand` decorators for automatic discovery
- Include both `up` and `down` logic in instance commands
- Never delete or rewrite committed instance command `up`/`down` logic
- See `packages/twenty-server/docs/UPGRADE_COMMANDS.md` for full documentation

### Utility Helpers
Use existing helpers from `twenty-shared` instead of manual type guards:
- `isDefined()`, `isNonEmptyString()`, `isNonEmptyArray()`

### Syncable Entities
When touching the syncable-entity subsystem, check `.cursor/skills/` first — there are six dedicated skills covering the relevant pieces:
- `syncable-entity-builder-and-validation`
- `syncable-entity-cache-and-transform`
- `syncable-entity-integration`
- `syncable-entity-runner-and-actions`
- `syncable-entity-testing`
- `syncable-entity-types-and-constants`

## Development Workflow

IMPORTANT: Use Context7 for code generation, setup or configuration steps, or library/API documentation. Automatically use the Context7 MCP tools to resolve library IDs and get library docs without waiting for explicit requests.

### Before Making Changes
1. Always run linting (`lint:diff-with-main`) and type checking after code changes
2. Test changes with relevant test suites (prefer single-file test runs)
3. Ensure instance commands are generated for entity changes (`database:migrate:generate`)
4. Check that GraphQL schema changes are backward compatible
5. Run `graphql:generate` after any GraphQL schema changes

### Styling & i18n
- **Linaria** for styling (zero-runtime CSS-in-JS, styled-components-style API).
- **Lingui** for internationalization — see `.cursor/rules/translations.mdc` for workflow (ignore its `react-i18next` references; the actual library is Lingui).

## Dev Environment Setup

All dev environments (Claude Code web, Cursor, local) use one script:

```bash
bash packages/twenty-utils/setup-dev-env.sh
```

This handles everything: starts Postgres + Redis (auto-detects local services vs Docker), creates databases, and copies `.env` files. Idempotent — safe to run multiple times.

- `--docker` — force Docker mode (uses `packages/twenty-docker/docker-compose.dev.yml`)
- `--down` — stop services
- `--reset` — wipe data and restart fresh
- **Skip the setup script** for tasks that only read code — architecture questions, code review, documentation, etc.

**Note:** CI workflows (GitHub Actions) manage services via Actions service containers and run setup steps individually — they don't use this script.

## Important Files
- `nx.json` - Nx workspace configuration with task definitions
- `tsconfig.base.json` - Base TypeScript configuration
- `package.json` - Root package with workspace definitions
- `.cursor/rules/` - Detailed development guidelines and best practices
