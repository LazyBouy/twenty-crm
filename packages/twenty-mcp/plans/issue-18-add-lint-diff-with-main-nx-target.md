# Plan: Add lint:diff-with-main Nx target to twenty-mcp project.json

> Issue(s): #18
> Package: packages/twenty-mcp
> Severity: medium
> Worst-case bug class if deferred: Done-because-foreground-checklist-empty — every future audit cycle's lint gate remains INCONCLUSIVE, allowing Prettier drift in in-flight files (e.g., crm.ts, views.ts) to go undetected at the gate and only surface via manual `npx prettier --check`. Multiple audits (#3, #7, #11, #12, #14) have already reported this.
> Created: 2026-05-12

## Problem statement

`packages/twenty-mcp/project.json` has a `"lint": {}` target that is an empty object (line 44), and no `lint:diff-with-main` target at all. Running `npx nx lint:diff-with-main twenty-mcp` fails with "Cannot find configuration for task twenty-mcp:lint:diff-with-main". Every audit cycle since audit-round-1 of issue #3 has reported the lint gate as INCONCLUSIVE because the standard audit command (`npx nx lint:diff-with-main <package>`) silently does nothing for `twenty-mcp`. Prettier drift in modified files goes undetected at the gate — it surfaces only if an auditor manually runs `prettier --check` against changed files. This is a structural gap that makes the audit process unreliable for this package.

## Reproduction

```bash
# Confirm the lint:diff-with-main target is missing:
npx nx lint:diff-with-main twenty-mcp
# Expected: "Cannot find configuration for task twenty-mcp:lint:diff-with-main" (fails)

# Confirm the lint target is an empty stub:
python3 -c "
import json
with open('packages/twenty-mcp/project.json') as f:
    d = json.load(f)
print('lint target:', json.dumps(d['targets'].get('lint', 'MISSING'), indent=2))
print('lint:diff-with-main target:', json.dumps(d['targets'].get('lint:diff-with-main', 'MISSING'), indent=2))
"
# Expected:
#   lint target: {}
#   lint:diff-with-main target: MISSING
```

## Root cause hypothesis

`packages/twenty-mcp/project.json:44` contains `"lint": {}` — an empty executor stub. The `lint:diff-with-main` target present in `packages/twenty-front/project.json` and `packages/twenty-server/project.json` was never ported to `twenty-mcp/project.json` when the `twenty-mcp` package was created. The package uses TypeScript and Prettier (both are in the monorepo's root `package.json`), but has no `.oxlintrc.json` file — meaning the `oxlint` portion of the other packages' lint commands cannot be used verbatim. The fix must produce a `lint:diff-with-main` target that at minimum runs `prettier --check` on changed `.ts` files; if `oxlint` is separately adoptable, it can be layered on.

## Proposed fix

1. **Check whether `packages/twenty-mcp/` has an `.oxlintrc.json`**:
   ```bash
   ls packages/twenty-mcp/.oxlintrc.json 2>/dev/null && echo found || echo missing
   ```
   - If **missing**: the `lint:diff-with-main` target should run Prettier only (no oxlint). The command mirrors `twenty-server`'s target but drops the oxlint invocation.
   - If **present**: mirror `twenty-server`'s full target exactly (oxlint + Prettier).

2. **Edit `packages/twenty-mcp/project.json`** — replace the empty `"lint": {}` stub and add `"lint:diff-with-main"` with a Prettier-only command (adapt if oxlint is available):

   ```json
   "lint": {
     "executor": "nx:run-commands",
     "options": {
       "cwd": "{projectRoot}",
       "command": "prettier src/ --check --cache --cache-location ../../.cache/prettier/{projectRoot} --cache-strategy metadata || (echo 'ERROR: Prettier formatting check failed! Fix with: npx nx lint twenty-mcp --configuration=fix' && false)"
     },
     "configurations": {
       "fix": {
         "command": "prettier src/ --write --cache --cache-location ../../.cache/prettier/{projectRoot} --cache-strategy metadata"
       }
     }
   },
   "lint:diff-with-main": {
     "executor": "nx:run-commands",
     "options": {
       "cwd": "{projectRoot}",
       "command": "FILES=$(git diff --name-only --relative --diff-filter=d main...HEAD -- src/ | grep -E '\\.(ts|tsx)$'); [ -z \"$FILES\" ] && echo 'No changed files.' || (prettier --check $FILES || (echo 'ERROR: Prettier formatting check failed! Fix with: npx nx lint:diff-with-main twenty-mcp --configuration=fix' && false))"
     },
     "configurations": {
       "fix": {
         "command": "FILES=$(git diff --name-only --relative --diff-filter=d main...HEAD -- src/ | grep -E '\\.(ts|tsx)$'); [ -z \"$FILES\" ] && echo 'No changed files.' || prettier --write $FILES"
       }
     }
   }
   ```

   If `oxlint` is present, prepend `npx oxlint --type-aware -c .oxlintrc.json $FILES &&` to the Prettier invocation in both `lint:diff-with-main` and `lint`, mirroring `packages/twenty-server/project.json`.

3. The `typecheck` target (already present and functional at `project.json:45–51`) is unchanged.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] Confirm `lint:diff-with-main` target is present in the edited `project.json`:
  ```bash
  python3 -c "
  import json
  with open('packages/twenty-mcp/project.json') as f:
      d = json.load(f)
  assert 'lint:diff-with-main' in d['targets'], 'lint:diff-with-main target missing'
  assert d['targets']['lint:diff-with-main'].get('executor') == 'nx:run-commands', 'wrong executor'
  print('OK')
  "
  # Expected: OK
  ```
- [ ] Run `lint:diff-with-main` and confirm it executes (not "Cannot find configuration"):
  ```bash
  npx nx lint:diff-with-main twenty-mcp
  # Expected: exits 0 with "No changed files." (on a clean branch)
  # OR: runs prettier check on any changed .ts files in src/ and exits 0
  ```
- [ ] Run `lint:diff-with-main` in fix mode and confirm it applies Prettier to changed files:
  ```bash
  npx nx lint:diff-with-main twenty-mcp --configuration=fix
  # Expected: exits 0; any changed .ts files are formatted in place (or "No changed files." if none)
  ```
- [ ] Run the full target against the current branch with at least one changed `.ts` file:
  ```bash
  # Touch a source file to create a diff vs main (revert after test):
  touch packages/twenty-mcp/src/index.ts
  git add packages/twenty-mcp/src/index.ts
  npx nx lint:diff-with-main twenty-mcp
  # Expected: command runs prettier --check on index.ts; exits 0 if well-formatted
  git restore --staged packages/twenty-mcp/src/index.ts && git restore packages/twenty-mcp/src/index.ts
  ```
- [ ] Confirm the `lint` target (full directory lint) also works after replacing the empty stub:
  ```bash
  npx nx lint twenty-mcp
  # Expected: exits 0 (all .ts files in src/ pass prettier check)
  ```

## Failure modes named (R3: adversarial pre-mortem)

1. **`git diff --name-only --relative` returns absolute paths on some CI runners**: the `--relative` flag was added to the server and front targets precisely to avoid this — but if `cwd` is not the package root when `git` runs, paths may not be relative. Mitigation: the target uses `"cwd": "{projectRoot}"` (same as `twenty-server`), so `git diff --relative` is run from `packages/twenty-mcp/` and returns paths relative to that directory. This matches the `prettier --check $FILES` invocation. Test plan item 4 exercises the path to confirm.

2. **`prettier` is not found at the workspace root** when `cwd` is the package dir: Prettier is installed in the workspace root `node_modules`, not inside `packages/twenty-mcp/node_modules`. The `twenty-server` and `twenty-front` targets call `prettier` bare (no `npx`) — they rely on Yarn's `bin` resolution. If `PATH` doesn't include workspace `node_modules/.bin`, the command fails. Mitigation: test plan item 2 catches this; if it fails with "prettier: command not found", the fix is to prefix `npx prettier` consistent with how `npx oxlint` is invoked in the other targets.

3. **The empty `"lint": {}` stub is replaced but the `inputs` / `cache` config from `twenty-server`'s `lint` target is not copied, causing Nx's cache to behave incorrectly**: if the `lint` target omits `cache: true` and the `inputs` list, repeated lint runs are not cached and may run unnecessarily in CI. Mitigation: this is a performance concern, not a correctness concern; the test plan verifies correctness (exits 0). Caching can be added in a follow-up if CI performance degrades.

## Out of scope

- Adding `oxlint` to `twenty-mcp` if it is not already configured (no `.oxlintrc.json` exists) — adopting oxlint requires creating and tuning a config file, which is a separate task. Worst case if deferred: Prettier drift is caught at the gate; oxlint violations (unused vars, etc.) are not. Acceptable because `tsc --noEmit` catches type errors and the existing unit tests catch logic errors; only code-style rules specific to oxlint are missed.
- Backfilling the `lint:diff-with-main` gate into historical audit retrospectives — the existing retrospectives accurately document INCONCLUSIVE; updating them is cosmetic and out of scope.
- Adding `lint:diff-with-main` to other packages that may also be missing it — scoped to `twenty-mcp` only per issue #18.

## References

- packages/twenty-mcp/project.json:44 (empty "lint": {} stub + missing lint:diff-with-main)
- packages/twenty-front/project.json (reference implementation for lint:diff-with-main with oxlint)
- packages/twenty-server/project.json (reference implementation for lint:diff-with-main, simpler than front — no twenty-shared dependency)
- packages/twenty-mcp/plans/issue-14-low-sweep-audit-round-1.md (audit that flagged the INCONCLUSIVE lint gate as a cross-cutting LOW → follow-up issue #18)
- packages/twenty-mcp/CLAUDE.md (before-shipping checklist — audit lint gate is a required step)
