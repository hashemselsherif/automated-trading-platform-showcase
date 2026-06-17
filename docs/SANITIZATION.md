# Sanitization Notes

This repository is a public showcase copy of selected production source files.

Excluded from this repository:

- `.env` files and strategy-specific local environment overlays
- wallet files, encrypted wallet blobs, and private key material
- Render secret files and deployment-only secret values
- local SQLite databases, runtime logs, caches, and result dumps
- generated backtest outputs and private analysis datasets
- private copy-trading wallet cohorts, overrides, and strategy-local tuning files

Environment variable names, neutral field descriptions, and public/static market metadata remain in the source because they are part of the application interface. Environment templates in `config/env-templates/` keep values blank. Literal credential values are not included.
