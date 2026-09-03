# Agent Guidance

## Model routing

- Use the current/default model for normal work. Model choice must not block progress.
- For delegated agents, prefer Terra for routine implementation, tests, documentation, and bounded refactoring.
- Reserve Sol for high-risk architecture, security-sensitive changes, difficult debugging, or cross-cutting review where the added reasoning depth is justified.
- Choose a model at a task boundary. Do not switch models midway through one cohesive task merely to reduce cost or latency.
- Preserve a model explicitly requested by the user. If that model is unavailable, state that briefly and continue with an available model unless the user required an exact model.
- Treat model names as current routing examples, not permanent capabilities. Follow the runtime's available-model list when it differs from this file.
- Do not claim that the active primary agent can switch itself. Model routing applies when the user changes the active model or when an authorized delegated agent is created.

## Versioning and releases

- Follow Semantic Versioning when making release-worthy changes: patch for backward-compatible fixes, minor for new backward-compatible functionality or material workflow/schema changes, and major for breaking changes.
- Bump the application and release version before packaging or handing off any material change. Do not overwrite or reuse a previously issued release number.
- Small internal coding changes with no user-visible behavior, such as tests, comments, documentation-only edits, or refactoring, may keep the current version unless they are being released independently.
- Keep canonical version sources, package metadata and lockfiles, changelog or release notes, archive names, and checksums consistent with the chosen version.
- Preserve older numbered release artifacts unless the user explicitly asks to remove them.
