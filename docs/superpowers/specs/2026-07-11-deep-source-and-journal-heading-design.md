# Deep Source Resolution and Journal Heading Compatibility Design

## Goal

Fix two lore engine defects:

1. Deep component pages must resolve their actual source file across supported languages and nested package paths, so worklist and manifest staleness track real files.
2. Journal materialization must recognize existing Chinese decision-history headings and normalize them to the canonical English heading.

The change must preserve current JavaScript behavior, surface invalid deep configuration through lint, and avoid mutating the mal-analyze-cli repository during regression testing.

## Scope

In scope:

- Shared supported-source-extension definition.
- Exact deep source resolution for configured modules.
- Nested deep roots that equal a configured `code_root` or lie beneath one.
- Correct deep worklist metadata and manifest stale scopes.
- Lint diagnostics for invalid deep roots, missing sources, and ambiguous sources.
- Chinese decision-history heading aliases during journal folding.
- Unit, integration, and mal-analyze-cli regression coverage.

Out of scope:

- Recursive inference of a module location from a bare subpackage name.
- Changing component page IDs or solving collisions where two deep roots use the same module basename.
- Deduplicating repeated modules in config, including the existing duplicate `scripts.e2e_smoke` entry in mal-analyze-cli.
- General YAML parser replacement or unrelated init discovery refactoring.

## Chosen Approach

Introduce a focused shared source-resolution module. Both init discovery and sync use one `CODE_EXT` definition, while sync resolves every configured deep module to exactly one existing repository-relative file.

This is preferred over local sync-only discovery because it prevents extension support from drifting between init and sync. Repository-level language inference is rejected because a single repository may contain Python, JavaScript, shell, and other supported source types simultaneously.

## Shared Source Resolution

Create `lib/source.js` with two public exports:

```js
export const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.swift', '.scala', '.sh',
]);

export function resolveDeepSource(repoRoot, deepRoot, mod) {
  // { status: 'ok', sourceFile }
  // { status: 'missing', candidates: [] }
  // { status: 'ambiguous', candidates }
}
```

Resolution rules:

1. Resolve only direct files under `deepRoot`; do not recursively search the repository.
2. Match a filename whose basename is exactly `mod` and whose extension is in `CODE_EXT`.
3. Return an `ok` result only for exactly one match.
4. Return `missing` for no matches and `ambiguous` for multiple supported matches.
5. Return repository-relative paths with `/` separators for stable Git pathspec behavior on Windows.
6. Never silently fall back to `.js`.

Examples:

| Deep root | Module | Result |
|---|---|---|
| `mal_analyze` | `cli` | `mal_analyze/cli.py` |
| `mal_analyze/native_enrichment` | `startup_paths` | `mal_analyze/native_enrichment/startup_paths.py` |
| `scripts` | `deploy` | `scripts/deploy.sh` |

`lib/init.js` imports `CODE_EXT` from this module. Its existing `discoverDeepModules` semantics remain unchanged.

## Deep Root Validation

A configured deep root is valid when it is either:

```js
deepRoot === codeRoot
```

or a path below a configured root:

```js
deepRoot.startsWith(`${codeRoot}/`)
```

The slash boundary is mandatory. For example, `src/pkg2` is not a child of `src/pkg`.

Examples:

| `code_roots` | Deep root | Valid |
|---|---|---|
| `mal_analyze` | `mal_analyze` | yes |
| `mal_analyze` | `mal_analyze/native_enrichment` | yes |
| `mal_analyze` | `native_enrichment` | no |
| `src/pkg` | `src/pkg2` | no |

## Sync Data Flow

Add an internal configured-deep resolver used by both `planSync` and `finalizeSync`. It produces resolved entries and configuration issues from the same inputs, preventing plan and manifest behavior from diverging.

A resolved deep worklist item has this contract:

```js
{
  axis: 'component',
  id: 'startup_paths',
  component: 'startup_paths',
  codeRoot: 'mal_analyze/native_enrichment',
  sourceFile: 'mal_analyze/native_enrichment/startup_paths.py',
  kind: 'deep',
  path: 'component/startup_paths.md',
  priorExists: true,
  stale: 1,
  reason: 'code-changed'
}
```

Responsibilities:

- `codeRoot` is the complete configured deep directory and is the runner's source entry.
- `sourceFile` is the exact file used for Git staleness checks.
- `id` and `path` retain the existing basename page convention.

The existing runner expression `page.codeRoot ?? page.sourceFile` then receives the correct directory without requiring runner behavior changes.

For finalize, the same resolved entry produces:

```js
staleScopes['component/startup_paths.md'] = [
  'mal_analyze/native_enrichment/startup_paths.py'
];
```

No guessed pathspec is written for unresolved entries.

## Plan Error Handling

`planSync` remains best-effort. A bad deep entry must not prevent unrelated component, theme, or flow work from being planned.

The return value gains `configIssues`:

```js
{
  codeRoots,
  themes,
  flows,
  worklist,
  configIssues: [
    {
      kind: 'deep-source-missing',
      deepRoot: 'mal_analyze',
      mod: 'not_here',
      expectedBase: 'mal_analyze/not_here'
    }
  ]
}
```

Missing, ambiguous, or invalid-root entries do not create deep worklist items. The `plan` CLI naturally exposes these issues in its JSON. Lint remains the enforcing quality gate.

## Lint Design

Do not hide validation inside `legalIds`, which currently returns only a set and cannot explain configuration failures.

Add an exported deep-config lint function that reports:

- `invalid-root`: deep key is neither a configured code root nor its child.
- `missing-source`: no supported direct source file exists for a configured module.
- `ambiguous-source`: multiple supported direct source files share the configured basename.

Diagnostic shape:

```js
{
  kind: 'invalid-root',
  deepRoot: 'native_enrichment',
  message: 'deep root must equal a code_root or be its child'
}
```

`lint()` gains a `deepConfig` array, includes it in `clean`, and the CLI prints a `deep-config` report line. `legalIds` only includes modules declared beneath valid deep roots, so invalid configuration cannot legitimize otherwise orphaned component pages.

Existing `lintUnfolded` behavior remains intact. It intentionally reports a literal journal token only when the page has already been finalized and stamped with `code_sha`; pre-finalize token-state pages remain valid.

## Decision-History Heading Compatibility

`foldJournal` recognizes this explicit alias set:

- `## Decision history`
- `## 决策史`
- `## 决策历史`
- `## 决策历史 (Decision history)`

The heading matcher remains restricted to known H2 aliases rather than matching arbitrary headings containing the word “decision.” Existing English suffix behavior remains supported.

When a recognized section contains the token or journal sentinel, `foldJournal` rebuilds it with the canonical heading:

```md
## Decision history
```

This gives tolerant input and normalized output. Existing Chinese pages self-heal on their next finalize without requiring an LLM rewrite. Hand-managed sections without a token or sentinel remain untouched, consistent with current behavior.

`commands/sync.md` already demonstrates only the canonical English heading. A short compatibility note may be added, but no template change is required.

## Testing Strategy

All behavior changes follow test-driven development.

### Shared resolver

Add `test/source.test.js` covering:

- Python, JavaScript, and shell resolution.
- Nested deep roots.
- Missing source.
- Multiple supported extensions for one basename.
- Forward-slash repository-relative output.

### Init compatibility

Extend `test/init.test.js` to confirm:

- Existing JavaScript discovery remains unchanged.
- Python and shell files remain discoverable through the shared extension set.
- Test/spec files and `__init__.py` remain excluded.

### Sync planning and stale tracking

Extend `test/sync.test.js` to confirm:

- Python sourceFile resolution.
- Nested deep root resolution.
- Deep worklist `codeRoot` and `sourceFile` fields.
- A commit touching the exact Python source creates `code-changed` work.
- A sibling-source commit does not stale the target deep page.
- Missing and ambiguous entries become `configIssues` and no worklist item.
- Manifest stale scopes use the resolved Python path.

### Lint

Extend `test/lint.test.js` to confirm:

- A code root and its nested deep paths are valid.
- A bare nested package and a similar path prefix are invalid.
- Missing and ambiguous source files are reported.
- Invalid roots do not contribute legal component IDs.
- Deep configuration issues make `clean` false and appear in CLI output.
- A finalized Chinese-heading page with a literal token is reported by `lintUnfolded`.

### Journal folding

Extend `test/sync.test.js` for each Chinese alias:

- Journal content is materialized.
- The literal token disappears.
- Exactly one sentinel region remains.
- The heading is normalized to English.
- The next H2 is preserved.
- Re-finalization is idempotent.

## Regression Verification

Run focused and complete engine suites:

```powershell
node --test test/source.test.js test/init.test.js test/sync.test.js test/lint.test.js
node --test test/*.test.js
```

Run mal-analyze-cli plan without modifying its config:

```powershell
node D:\workspace\lore\lib\sync.js plan D:\workspace\mal-analyze-cli\.lore --all
```

Confirm representative paths:

- `mal_analyze/cli.py`
- `server/worker.py`
- `scripts/deploy.sh`

Test the nested entry in a temporary copy of the lore config, not in the real mal-analyze-cli checkout:

```yaml
mal_analyze/native_enrichment: [startup_paths]
```

Expected worklist metadata:

```text
codeRoot: mal_analyze/native_enrichment
sourceFile: mal_analyze/native_enrichment/startup_paths.py
```

Finally run:

```powershell
node D:\workspace\lore\lib\lint.js D:\workspace\mal-analyze-cli\.lore
```

Expected result is zero unfolded tokens and no deep configuration errors. Any unrelated existing lint finding must be reported separately rather than hidden by this change.

## Delivery Boundaries

Implementation should be split into two reviewable commits:

1. Deep source resolution, stale scopes, and deep configuration lint.
2. Localized decision-history folding and its lint regression coverage.

The existing duplicate `e2e_smoke` module in the mal-analyze-cli config is recorded as a separate issue and is not silently fixed as part of these engine changes.
