# Theme Multi-Source Deep Pages Design

**Date:** 2026-08-05

**Status:** Requirements approved; implementation deferred to a separate session

## Goal

Add native deep pages for a Lore theme when one responsibility spans multiple source files or directories. A theme overview remains the cross-cutting map, while each child page owns a bounded multi-source mechanism and participates in the same planning, staleness, quality, manifest, graph, MCP, and navigation lifecycle as existing component deep pages.

The motivating case is `mal-analyze-cli` Sidecar configuration decryption. Its useful deep-page boundaries are discovery and association, crypto execution, coordination lifecycle, and canonical propagation. Each boundary crosses several modules, so the existing one-source-file component deep page cannot represent it without either fragmenting the mechanism or assigning misleading stale scopes.

## Current Limitation

Lore has two relevant page types:

- A component deep page is declared under `axes.component.deep`. It maps one page to one resolved source file and receives precise incremental staleness, mechanism lint, manifest metadata, and graph visibility.
- A theme page is declared under `axes.theme.values`. It is a single cross-cutting overview matched from journal atoms and has no native child-page or multi-source stale contract.

Component grouping changes sidebar order only. It does not combine several modules into one page. Handwritten theme child pages are also insufficient because they do not enter `planSync`, cannot declare source scopes, are not recognized as deep pages by lint, and can become orphaned after configuration changes.

## Non-Goals

- Replacing the lightweight configuration parser with a general YAML parser.
- Changing existing component deep-page resolution or page IDs.
- Inferring multi-source children automatically from repository structure or commit history.
- Allowing arbitrary files outside the repository as source scopes.
- Adding a nested physical directory hierarchy to the wiki.
- Rewriting existing theme pages or migrating projects that do not opt in.
- Implementing the feature as part of the `mal-analyze-cli` documentation task.

## Chosen Model

Introduce an explicit `axes.theme.deep` block. Each parent theme owns ordered groups of child specifications. A child specification has a stable local ID and an explicit non-empty set of repository-relative source paths or globs.

Example:

```yaml
axes:
  theme:
    values:
      - { id: sidecar-config-decryption, desc: "Evidence-driven sidecar config decryption", match: [sidecar, config_crypto] }
    deep:
      sidecar-config-decryption:
        发现与关联:
          - { id: discovery-association,
              sources: [mal_analyze/sidecar/probe.py,
                        mal_analyze/sidecar/associations.py,
                        mal_analyze/sidecar/models.py] }
        执行与传播:
          - { id: crypto-execution,
              sources: [mal_analyze/sidecar/executor.py,
                        mal_analyze/sidecar/materials.py,
                        mal_analyze/native_enrichment/crypto_evidence.py,
                        mal_analyze/extractors/profiles/sidecar_scfg_aes_gcm.py] }
          - { id: canonical-propagation,
              sources: [mal_analyze/native_enrichment/finalize_findings.py,
                        server/analyst/**,
                        server/gateway/report_contract.py] }
```

The exact parser-friendly serialization may use one-line child records, but the semantic contract is the same:

```js
{
  parent: 'sidecar-config-decryption',
  id: 'discovery-association',
  group: '发现与关联',
  sources: [
    'mal_analyze/sidecar/probe.py',
    'mal_analyze/sidecar/associations.py',
    'mal_analyze/sidecar/models.py',
  ],
}
```

## Stable Identity and Physical Paths

Keep theme pages physically flat to preserve current manifest, serve, and axis assumptions.

- Parent: `theme/sidecar-config-decryption.md`
- Child: `theme/sidecar-config-decryption--discovery-association.md`

The canonical child page ID is `<parent>--<child>`. Both segments must match the existing theme ID character set, and `--` is reserved as the parent/child separator for this feature.

The manifest stores explicit structure rather than deriving it only from the filename:

```json
{
  "id": "sidecar-config-decryption--discovery-association",
  "axis": "theme",
  "kind": "deep",
  "parent": "sidecar-config-decryption",
  "group": "发现与关联",
  "sources": ["mal_analyze/sidecar/probe.py", "mal_analyze/sidecar/associations.py"]
}
```

Explicit metadata prevents accidental hierarchy from an unrelated theme ID that happens to contain `--` and gives the shell, graph, and MCP one stable contract.

## Configuration Parsing and Validation

Add a focused parser such as `parseConfigThemeDeep(configText)`. It returns ordered parents and ordered child records without changing `parseConfigThemes`.

Validation rules:

1. Every parent must exist exactly once in `axes.theme.values`.
2. Child IDs are unique within a parent; canonical `<parent>--<child>` IDs are unique across all theme pages.
3. Each child has at least one source entry.
4. Source entries are repository-relative, slash-normalized paths or supported glob patterns.
5. Absolute paths, drive-qualified paths, `..` traversal, NULs, and paths resolving outside the repository are rejected.
6. A literal source must exist and be a regular file.
7. A glob must match at least one regular file. No match is `missing-source`, never a fresh page.
8. Resolved sources are deduplicated and sorted for fingerprint stability while configured child/group order remains stable for presentation.
9. Symlinks or junctions that resolve outside the repository are rejected.
10. A child may share a source with another child. Overlap is valid because responsibilities may intersect; the worklist must report it, not silently remove it.

Configuration errors are accumulated into actionable diagnostics rather than crashing after the first malformed child.

## Source Resolution Contract

Create a shared resolver for literal and glob sources. Its public result should distinguish valid, missing, invalid, and escaping inputs:

```js
resolveThemeDeepSources(repoRoot, entries)
// { status: 'ok', sourceFiles: ['path/to/file.js'] }
// { status: 'missing', entry, matches: [] }
// { status: 'invalid', entry, reason }
// { status: 'outside-repo', entry, resolvedPath }
```

All returned paths use `/` separators. Git pathspecs, manifest sources, fingerprints, diagnostics, and Windows tests consume the same normalized list.

Directory globs must not traverse ignored metadata or generated wiki output unless explicitly allowed by a future contract. At minimum, `.git/` and `.lore/` are excluded from theme-deep source expansion to avoid self-staleness.

## Sync Planning

`planSync` creates a work item for each valid child:

```js
{
  axis: 'theme',
  id: 'sidecar-config-decryption--discovery-association',
  kind: 'deep',
  parent: 'sidecar-config-decryption',
  group: '发现与关联',
  sourceFiles: ['mal_analyze/sidecar/probe.py'],
  path: 'theme/sidecar-config-decryption--discovery-association.md',
  priorExists: true,
  stale: 3,
  reason: 'source-changed',
}
```

Planning rules:

- `--all` queues every configured child.
- A missing child page is queued as `missing-page` when its configuration is valid.
- Otherwise staleness is the number of commits since the page `code_sha` affecting any resolved source file.
- A sibling child is not queued when none of its source files changed.
- Invalid configuration produces diagnostics and no rewrite work item for that child.
- Parent theme matching remains journal-driven. Child source changes do not force an overview rewrite unless the parent is independently stale under existing rules.
- Auto mode counts child pages against page limits and quality gates exactly once.

## Page Content Contract

A theme deep page is a mechanism-grade page, not a second overview. It follows the existing two-tier quality model and must contain:

- title and summary frontmatter;
- a clear responsibility boundary;
- inputs and outputs;
- mechanism/data-flow explanation;
- source-symbol anchors using `symbol @ file`;
- failure and edge-case behavior;
- cross-links to its parent and related children;
- no manually materialized Decision history section.

The parent overview lists all configured children in group/order sequence. A child must link back to the parent. Lint checks both directions after all pages are available.

The backend prompt receives the bounded `sourceFiles` list and is instructed not to generalize beyond that source set. Large multi-source sets remain subject to existing context and timeout budgets; configuration should prefer cohesive responsibilities over whole-repository globs.

## Finalization and Staleness

`finalizeSync` adds each valid child to `staleScopes`:

```js
staleScopes['theme/sidecar-config-decryption--discovery-association.md'] = [
  'mal_analyze/sidecar/probe.py',
  'mal_analyze/sidecar/associations.py',
  'mal_analyze/sidecar/models.py',
];
```

The same resolved list is used for planning, page frontmatter/manifest metadata, and post-finalize stale calculation. Independent re-resolution in those layers is forbidden because path or glob drift would create contradictory freshness states.

The child page `code_sha` advances only after it passes the normal write and quality gates. Failed rewrites stay stale and retain the last valid page.

## Manifest, Navigation, Graph, and MCP

### Manifest

Extend page entries with optional `kind`, `parent`, `sources`, and existing `group`. Ordinary pages omit these fields so existing snapshots remain stable.

### INDEX and shell

The Theme section shows each overview at top level and configured children beneath it in group/order sequence. Children must not also appear as unrelated top-level theme entries.

Removing a child from configuration makes an existing child page an orphan. Finalization must report the orphan and apply one explicit policy selected during implementation:

- preferred: remove the generated page only when its manifest metadata proves it was a managed theme-deep page;
- acceptable fallback: keep the file but exclude it from navigation and fail lint until explicitly cleaned.

Silent orphan retention in normal navigation is not allowed.

### Graph

Add a structural edge from parent page to child page. Use one stable type, preferably `contains`; reverse traversal is naturally available through neighbors. Existing Wiki refs remain independent `refs_related` edges.

### MCP

`lore_page` can read a child by canonical ID. `lore_neighbors` on the parent returns child pages through the structural edge, and on a child returns its parent. `lore_ask` indexes child sections normally and includes parent/kind metadata in results where page metadata is already returned.

## Lint and Failure Diagnostics

Add diagnostics for:

- `theme-deep-parent-missing`
- `theme-deep-id-collision`
- `theme-deep-sources-empty`
- `theme-deep-source-invalid`
- `theme-deep-source-missing`
- `theme-deep-source-outside-repo`
- `theme-deep-page-missing`
- `theme-deep-parent-link-missing`
- `theme-deep-child-link-missing`
- `theme-deep-mechanism-missing`
- `theme-deep-orphan`

Diagnostics include parent ID, child ID, raw source entry, normalized candidate where safe, and a direct remediation. They must not print arbitrary file contents.

## Backward Compatibility

Compatibility is a hard gate:

1. With no `axes.theme.deep`, `planSync`, finalize outputs, manifest JSON, graph JSON, INDEX ordering, shell navigation, lint output, and MCP behavior remain unchanged.
2. Existing `axes.component.deep` flat/grouped/pinned syntax and semantics remain unchanged.
3. Existing theme page IDs that do not opt into children remain top-level pages.
4. Existing consumers tolerate the new optional manifest fields.
5. Migration does not inject a `theme.deep` block automatically; an optional commented scaffold may be considered separately.

## Security and Resource Boundaries

- Resolve all source entries beneath the repository root after symlink/junction resolution.
- Bound the number of children per parent, configured source entries per child, expanded files per glob, and total expanded files per sync plan.
- Reject or truncate nothing silently. Budget excess is a configuration diagnostic.
- Never read matched source contents during config parsing or lint path validation.
- Backend rewriting retains existing read-only tool restrictions and token-state journal behavior.
- A broad glob cannot include `.lore`, `.git`, dependency caches, or output directories through default traversal.

Exact limits should be named constants and covered by boundary tests during implementation.

## Test Strategy

### Config parser

- One parent with flat children.
- Grouped children preserve group and order.
- Multiple parents remain isolated.
- Missing parent, duplicate child, canonical collision, empty sources, malformed record, and no block.
- Existing `parseConfigThemes` fixtures are unchanged.

### Source resolution

- Literal files and globs resolve to stable slash-normalized paths.
- Duplicate and overlapping matches deduplicate deterministically.
- Missing literal/glob, absolute path, drive path, traversal, outside-repo symlink/junction, and budget overflow fail closed.
- Windows and Linux path fixtures produce equivalent logical output.

### Sync planning and finalize

- Missing page queues one child.
- One changed source queues only associated children.
- Shared source queues each child that declares it.
- Unrelated source changes do not stale a child.
- `--all` and auto page budgets include children.
- Planning and finalized `staleScopes` use the exact same source list.
- Failed rewrite retains the previous page and stale state.

### Manifest, INDEX, graph, shell, and MCP

- Optional child metadata is emitted only for theme deep pages.
- INDEX/sidebar nests children under the parent and honors groups/order.
- Parent/child structural graph edges support both traversal directions.
- MCP can read and navigate children.
- Orphan policy is deterministic and tested.

### Lint and content quality

- Missing mechanism section, missing parent/child links, missing page, invalid source, and orphan diagnostics.
- Overview pages are not incorrectly required to satisfy deep-page mechanism lint.
- Component deep-page lint remains unchanged.

### Backward compatibility

Run existing parser, sync, manifest, graph, lint, serve, portal, runner, and MCP suites with fixtures that have no `theme.deep`; snapshots and behavior must remain unchanged.

## Acceptance Criteria

The feature is complete only when:

1. A fixture theme can declare at least two grouped multi-source children.
2. Changing one source queues precisely the affected children.
3. Plan, finalize, manifest, graph, INDEX, shell, lint, and MCP agree on child identity, parent, group, and source set.
4. Negative path and orphan cases fail with actionable diagnostics.
5. Windows and Linux tests agree on normalized source identities.
6. Repositories without `theme.deep` retain prior output and pass the full existing suite.
7. A real `mal-analyze-cli` Sidecar configuration can generate one overview plus four responsibility-oriented deep pages without treating them as component single-source pages.

## Implementation Handoff

The implementation session should use this document as the requirements source, then create a separate detailed plan. It must inspect the latest `lib/config.js`, `lib/source.js`, `lib/sync.js`, `lib/manifest.js`, `lib/graph.js`, `lib/lint.js`, site navigation, MCP handlers, and their tests before assigning tasks, because the current Lore worktree contains active deep-source-disambiguation changes that may alter shared source-resolution contracts.
