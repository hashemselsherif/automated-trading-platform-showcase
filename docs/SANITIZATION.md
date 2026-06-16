# Sanitization Notes

This repository is a public showcase copy of selected production source files.

Excluded from this repository:

- `.env` files and strategy-specific local environment overlays
- wallet files, encrypted wallet blobs, and private key material
- Render secret files and deployment-only secret values
- local SQLite databases, runtime logs, caches, and result dumps
- generated backtest outputs and private analysis datasets

Environment variable names remain in the source because they are part of the application interface. Literal credential values are not included.
