# Project Instructions

- `spec/*.md` is the source of truth for behavior and architecture. `README.md` indexes it.
- Read the related spec before editing, and update it when behavior or architecture changes.
- When code and spec disagree, confirm the intent before changing the contract.
- Keep docs short and direct. Use ASCII in prose.

## Modeling

- Change the TypeScript source, never `.vibecad/`.
- Drive dimensions from named params with a short comment. Name features with `.named()`.
- Select faces and edges by name. Never by index.
- Run `node src/cli.ts build <entry>` and `node src/cli.ts test <entry>` after changes.
- Run `npm test` and `npm run typecheck` after changing `src/`.
