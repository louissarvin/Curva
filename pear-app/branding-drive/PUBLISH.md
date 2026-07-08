# Publishing the Curva branding pack

Follow these steps to publish the branding drive as a `pear://` share.

1. Ensure `pear` CLI is installed globally.
2. In `pear-app/branding-drive/`:
   ```
   pear touch
   ```
   Save the printed key.
3. Stage:
   ```
   pear stage pear://<key> . --json
   ```
   Copy the versioned link `pear://<fork>.<length>.<key>` from the output.
4. Seed:
   ```
   pear seed pear://<key> .
   ```
5. Paste the versioned link into `../package.json` at `pear.assets.branding.link`.
6. Re-stage the main app:
   ```
   cd ..
   pear stage pear://<CURVA_APP_KEY> . --json
   ```
7. Verify: launch Curva, watch console for `assets:branding` event with a valid `path`.

## Notes

- `link` MUST be the versioned form (`pear://<fork>.<length>.<key>`). A plain `pear://<key>` is silently ignored per the Pear configuration reference.
- Every content change to this drive bumps `length`. Republish and re-paste the link into `../package.json` after every crest swap, then re-stage the main app.
- Total drive size should stay under ~5 MB. This pack ships small SVGs plus a JSON manifest.
