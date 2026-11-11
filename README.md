# koodo-reader (PWA deployment)

Automated PWA deployment of [Koodo Reader](https://github.com/koodo-reader/koodo-reader)
to GitHub Pages at **https://sloth-os.github.io/koodo-reader/**.

A GitHub Actions workflow checks out upstream `koodo-reader/koodo-reader@dev`,
applies this repo's patches and overlay, builds with vite, and deploys the
result. It runs weekly (to track upstream), on every push to `main`, and
manually via workflow_dispatch.

## What this adds on top of upstream

1. **Installable PWA** — `manifest.json`, theme color, app icons (including
   maskable), and a hand-rolled service worker:
 - precaches the app shell (index.html + built assets + the vendored
     `lib/` scripts) with a per-deploy revision so new deploys activate
     cleanly and old caches are dropped
   - runtime cache-first for on-demand same-scope assets (wasm, pdf cmaps,
     standard fonts, locale chunks, workers)
   - offline fallback page; navigations fall back to the cached shell
2. **OS file handling** — `file_handlers` in the manifest registers Koodo for
   all ~30 supported formats; a `launchQueue` consumer imports launched
 files through the app's own `importBookFunc` pipeline (waiting for the
   manager page to mount if the launch lands elsewhere).
3. **Subpath fixes** — the app is served under `/koodo-reader/`, but some
   upstream code builds root-absolute `/lib/...` URLs that 404 under a
   subpath. Patches make these resolve relative to `document.baseURI`.

## Repo layout

- `overlay/` — files copied into the upstream tree before building:
  - `manifest.json` (PWA metadata + file_handlers + shortcuts)
  - `sw.js` (service worker template; revision/precache list substituted at
    build time)
  - `offline.html` (offline fallback document)
  - `icons/` (generated from upstream's app icon)
  - `file-handling.ts` (launchQueue consumer module)
- `patches/` — unified diffs applied to the upstream tree (ordered by name):
  - `0001-entry-file-handling.patch` — wire `initFileHandling()` into the
    app entrypoint
  - `0003-tesseract-subpath.patch` — tesseract worker URL resolves against
    `document.baseURI`
- `scripts/build.mjs` — the whole pipeline: sanity checks → patches →
  overlay → kookit bundle subpatch (exact-string, asserted) → vite build →
  inject PWA tags into `index.html` → generate SW precache manifest → write
  version-stamped `sw.js`
- `.github/workflows/deploy.yml` — CI/CD

## Local development

```bash
# clone upstream next to this repo (or anywhere) and install deps
git clone https://github.com/koodo-reader/koodo-reader.git ~/software/koodo-reader
cd ~/software/koodo-reader && yarn install --ignore-scripts

# build with the overlay applied
node scripts/build.mjs --upstream ~/software/koodo-reader

# serve the build under the production subpath to verify
mkdir -p /tmp/pages/koodo-reader
cp -r ~/software/koodo-reader/build/* /tmp/pages/koodo-reader/
cd /tmp/pages && python3 -m http.server 8123
# open http://127.0.0.1:8123/koodo-reader/
```

`PWA_BASE_PATH` (default `/koodo-reader/`) controls the scope prefix the
service worker treats as in-scope.

## Patch drift

The patches and the kookit exact-string replacements are asserted at build
time: if upstream refactors the relevant lines, the build fails loudly
instead of silently producing a broken PWA. When that happens, regenerate
the patch against the new tree (see the patch headers for target files).

Upstream license: Apache-2.0 (see the LICENSE shipped in the build output).
