# Releasing

## Desktop app

The desktop app (Tauri) is released by pushing a semver tag. CI does the rest.

```bash
git tag v0.1.x
git push origin v0.1.x
```

This triggers `.github/workflows/desktop.yml`, which:

1. Builds the macOS app (ad-hoc signed) and Linux app in parallel
2. Signs the updater bundles with the Tauri signing key
3. Generates `latest.json` from the build artifacts
4. Creates a GitHub Release and uploads all artifacts + `latest.json`

Existing installs check `latest.json` on next launch and update automatically.

### Secrets required

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Signs updater bundles (minisign private key contents) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |

The corresponding public key is embedded in `desktop/tauri.conf.json`.

### Version bump

Update the version in `desktop/tauri.conf.json` to match the tag before pushing it:

```json
"version": "0.1.x"
```
