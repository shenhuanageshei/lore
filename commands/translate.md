# /lore:translate

Translate one wiki page into a target language sidecar.

1. Run `node lib/translate.js plan <loreDir> <pagePath> <targetLang>`.
2. Read `source_body`, translate prose, and write the Markdown body to `target_path`.
3. Run `node lib/translate.js finalize <loreDir> <pagePath> <targetLang>`.
4. Review the sidecar diff and `.lore/wiki/.manifest.json`.

Keep code fences, wikilinks, Mermaid syntax, tables, and command names unchanged unless the surrounding prose requires translation.
