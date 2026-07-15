# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js 20+ npm-workspaces monorepo. TypeScript packages live in `packages/`: `agent` handles payer actions, `facilitator` batches settlements, `integrations` contains platform adapters, and `sdk` shares client types. `resource-adapter` supports x402 resources; `middleware` is the legacy per-request path. The JavaScript-only `extension` and `peertube-plugin` packages provide browser and PeerTube adapters. Solidity contracts, Foundry tests, and deployment scripts live in `contracts/{src,test,script}`. Longer design notes and deployment recipes are in `docs/`, `work/`, and `packages/integrations/deploy/`.

## Build, Test, and Development Commands

- `npm install`: install all workspace dependencies (Node 20+).
- `npm run build --workspaces --if-present`: build packages and export contract ABIs.
- `npm test --workspaces --if-present`: run Vitest, package-specific Node tests, and Foundry tests.
- `npm run typecheck --workspaces --if-present`: type-check TypeScript workspaces that expose the script.
- `npm run lint`: lint the middleware TypeScript package.
- `npm run format:check` / `npm run format`: check or apply repository formatting.
- `npm run e2e:anvil -w @universal-paywall/integrations`: exercise the stake-to-settlement flow; requires Anvil on port 8545 and built contracts.

Use `-w <workspace-name>` to target one package, for example `npm test -w @universal-paywall/agent`. Run `forge test` from `contracts/` for contract-only tests.

## Coding Style & Naming Conventions

Prettier uses two spaces, single quotes, semicolons, trailing commas, and a 100-column width. TypeScript is strict; avoid unchecked indexing and preserve exact optional-property semantics. Use `camelCase` for functions and variables, `PascalCase` for types/classes/contracts, and kebab-case package directories. Do not modify upstream platform forks; integrate through supported config, plugin, proxy, provider, or sidecar surfaces.

## Testing Guidelines

Place TypeScript tests in `src/__tests__/*.test.ts` and Solidity tests in `contracts/test/**/*.t.sol`. Use Vitest for TypeScript and Forge for Solidity. Add focused unit tests for behavior changes; payment-path changes should also cover the relevant Anvil E2E script. No fixed coverage threshold is documented, but middleware coverage is available with `npm run test:coverage -w @universal-paywall/middleware`.

## Commit & Pull Request Guidelines

Follow the existing scoped Conventional Commit style: `feat(integrations): ...`, `fix(middleware): ...`, `test(extension): ...`, or `docs: ...`. Keep commits focused. Branch from `dev` and target PRs to `dev` (`main` is production). PRs should explain behavior and validation, link relevant issues/tasks, call out configuration or contract changes, and include screenshots or logs for browser, plugin, or live-platform flows. Never commit real keys; annotate only known public Anvil test keys with `// gitleaks:allow`.
