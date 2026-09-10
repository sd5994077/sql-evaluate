# Contributing

## Branch workflow

1. Start from the approved integration base and run `git status --short`.
2. If the tree is not clean, identify the owner and purpose of each path before continuing. Do not discard or absorb unrelated work.
3. Run the applicable baseline checks before starting a new feature or fix.
4. Create one descriptive branch for one cohesive outcome, such as `feature/investigation-history` or `fix/import-input-contract`.
5. Keep code, tests, documentation, release metadata, and artifacts within that outcome's scope. Start a separate branch when the purpose changes.
6. Make atomic commits with a conventional prefix: `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.
7. Before handoff or merge, inspect the intended diff, run the relevant checks, and report the exact validation result and any residual warnings.

## Local artifacts

- Do not commit captures, investigation archives, exports, logs, secrets, temporary screenshots, or scratch patches.
- Add a `.gitignore` rule only when the artifact pattern is stable and local-only.
- Do not ignore real source, tests, documentation, fixtures, or release artifacts just to obtain a clean status.

## SQL Evaluate boundary

- This repository is an offline, file-only application and must not connect to SQL Server.
- Generated SQL is an operator-reviewed artifact. Run it only outside this repository and its test environment.
