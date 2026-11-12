#!/usr/bin/env node
/**
 * Build script for the Koodo Reader PWA deployment.
 *
 * Runs INSIDE a checkout of upstream koodo-reader/koodo-reader (the CI job
 * checks it out; locally it's the sibling ~/software/koodo-reader clone).
 *
 * Steps:
 *   1. sanity-check the upstream tree looks like koodo-reader
 *   2. apply patches/ (git apply --check first, then apply)
 *   2b. assert the overlay's runtime contracts with upstream (anchor strings)
 *   3. copy overlay/ files in (manifest, sw, offline page, icons, module)
 *   4. patch the vendored kookit bundle for subpath hosting (exact-string
 *      replacements, asserted)
 *   5. vite build
 *   6. post-process build/: inject manifest/SW tags into index.html,
 *      generate the SW precache manifest, substitute it into sw.js
 *   7. write build-info.json artifact metadata (provenance)
 *
 * Usage: node scripts/build.mjs [--upstream <path>]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const UPSTREAM = path.resolve(argValue("--upstream", process.cwd()));
const PATCHES = path.join(REPO, "patches");
const OVERLAY = path.join(REPO, "overlay");

// The GitHub Pages subpath this is deployed under.
const BASE_PATH = process.env.PWA_BASE_PATH || "/koodo-reader/";

const log = (msg) => console.log(`[build] ${msg}`);
const die = (msg) => {
  console.error(`[build] FATAL: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. sanity checks
// ---------------------------------------------------------------------------
const pkgPath = path.join(UPSTREAM, "package.json");
if (!fs.existsSync(pkgPath)) die(`no package.json at ${UPSTREAM}`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (pkg.name !== "koodo-reader") die(`unexpected package name: ${pkg.name}`);
if (!fs.existsSync(path.join(UPSTREAM, "vite.config.mts"))) {
  die("vite.config.mts missing - not a koodo-reader checkout?");
}

// ---------------------------------------------------------------------------
// 2. apply patches
// ---------------------------------------------------------------------------
const { execFileSync } = await import("node:child_process");
const patchFiles = fs
  .readdirSync(PATCHES)
  .filter((f) => f.endsWith(".patch"))
  .sort();
for (const patchFile of patchFiles) {
  const patchPath = path.join(PATCHES, patchFile);
  const content = fs.readFileSync(patchPath, "utf8");
  const m = content.match(/^--- a\/(.+)$/m);
  const target = m ? path.join(UPSTREAM, m[1]) : null;
  const alreadyApplied =
    target &&
    fs.existsSync(target) &&
    content
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n")
      .length > 0 &&
    (() => {
      // crude idempotency: patch is applied if the first added line exists
      // verbatim in the target file
      const added = content
        .split("\n")
        .find((l) => l.startsWith("+") && !l.startsWith("+++"));
      if (!added) return false;
      const needle = added.slice(1).trim();
      if (!needle) return false;
      return fs.readFileSync(target, "utf8").includes(needle);
    })();

  if (alreadyApplied) {
    log(`patch ${patchFile}: already applied, skipping`);
    continue;
  }
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("git", ["apply", "--check", patchPath], { cwd: UPSTREAM });
    execFileSync("git", ["apply", patchPath], { cwd: UPSTREAM });
    log(`patch ${patchFile}: applied`);
  } catch (error) {
    die(`patch ${patchFile} failed: ${error.stderr || error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2b. upstream runtime contracts (asserted)
// ---------------------------------------------------------------------------
// The overlay reaches into upstream through runtime contracts that neither
// the patches nor any type-check protect: the CSS class queried for importer
// liveness, the store's placeholder importBookFunc, route names, the
// startup-loaded theme.css, supportedFormats and the favicon injection
// anchor. If upstream renames any of these, die HERE: a green weekly build
// with a silently dead file-handling path is worse than a red one.
const contractAnchors = [
  ["src/components/importLocal/component.tsx", ['className="import-from-local"']],
  ["src/store/useAppStore.ts", ["importBookFunc: (() => {})"]],
  ["src/router/index.tsx", ['path="/manager/*"']],
  ["src/utils/reader/launchUtil.ts", ["./assets/styles/theme.css"]],
  ["src/utils/common.ts", ["export const supportedFormats"]],
  ["index.html", ['<link rel="icon" href="./favicon.png" />']],
];
for (const [relPath, needles] of contractAnchors) {
  const fullPath = path.join(UPSTREAM, relPath);
  if (!fs.existsSync(fullPath)) die(`contract file missing: ${relPath}`);
  const src = fs.readFileSync(fullPath, "utf8");
  for (const needle of needles) {
    if (!src.includes(needle)) {
      die(
        `upstream contract broken: ${relPath} no longer contains ${JSON.stringify(needle)}`
      );
    }
  }
}
log("upstream runtime contracts asserted");

// ---------------------------------------------------------------------------
// 3. overlay files
// ---------------------------------------------------------------------------
const copy = (src, dest) => fs.cpSync(src, dest);
const copyDir = (src, dest) => fs.cpSync(src, dest, { recursive: true });

// manifest, offline page and icons are public/ assets
copy(path.join(OVERLAY, "manifest.json"), path.join(UPSTREAM, "public", "manifest.json"));
copy(path.join(OVERLAY, "offline.html"), path.join(UPSTREAM, "public", "offline.html"));
copyDir(path.join(OVERLAY, "icons"), path.join(UPSTREAM, "public", "icons"));

// file-handling module into src/utils/web/
fs.mkdirSync(path.join(UPSTREAM, "src/utils/web"), { recursive: true });
copy(
  path.join(OVERLAY, "file-handling.ts"),
  path.join(UPSTREAM, "src/utils/web/fileHandling.ts")
);
log("overlay files copied");

// ---------------------------------------------------------------------------
// 4. kookit subpath patch (exact-string, asserted)
// ---------------------------------------------------------------------------
const kookitPath = path.join(UPSTREAM, "src/assets/lib/kookit.min.js");
let kookit = fs.readFileSync(kookitPath, "utf8");

// Resolves to the directory the app is served from, WITHOUT a trailing
// slash: "/koodo-reader" under Pages, "" at a domain root. (A trailing
// slash would produce protocol-relative "//lib/..." URLs at the root.)
const WEB_BASE_HELPER =
  'const koodoWebBase=()=>{try{return new URL(".",document.baseURI).pathname.replace(/\\/+$/,"")}catch(e){return""}};';

const kookitReplacements = [
  [
    'const pdfjsPath=path=>`${isElectron()?".":""}/lib/pdfjs/${path}`',
    WEB_BASE_HELPER +
      'const pdfjsPath=path=>`${isElectron()?".":koodoWebBase()}/lib/pdfjs/${path}`',
  ],
  [
    'const url=`${isElectron$1()?".":""}/lib/highlight-js/${path}`',
    'const url=`${isElectron$1()?".":koodoWebBase()}/lib/highlight-js/${path}`',
  ],
  [
    'const cssPath=()=>`${isElectron$1()?".":""}/lib/${window.bookLayout}-css/',
    'const cssPath=()=>`${isElectron$1()?".":koodoWebBase()}/lib/${window.bookLayout}-css/',
  ],
];

for (const [oldStr, newStr] of kookitReplacements) {
  if (kookit.includes(newStr)) {
    log(`kookit: replacement already present (${oldStr.slice(0, 40)}...)`);
    continue;
  }
  const count = kookit.split(oldStr).length - 1;
  if (count !== 1) {
    die(
      `kookit pattern matched ${count} times (expected 1): ${oldStr.slice(0, 60)}`
    );
  }
  kookit = kookit.replace(oldStr, newStr);
}
fs.writeFileSync(kookitPath, kookit);
log("kookit bundle patched for subpath");

// ---------------------------------------------------------------------------
// 5. build
// ---------------------------------------------------------------------------
const viteBin = path.join(UPSTREAM, "node_modules", ".bin", "vite");
if (!fs.existsSync(viteBin)) die("vite not installed - run npm ci first");
execFileSync(viteBin, ["build"], { cwd: UPSTREAM, stdio: "inherit" });
log("vite build complete");

// ---------------------------------------------------------------------------
// 6. post-process build/
// ---------------------------------------------------------------------------
const BUILD = path.join(UPSTREAM, "build");

// 6a. inject PWA tags into index.html (after the favicon link)
const indexPath = path.join(BUILD, "index.html");
let indexHtml = fs.readFileSync(indexPath, "utf8");
// Gate on the exact tags WE inject (idempotent re-runs), not on a loose
// "manifest.json" substring: if upstream ever ships its own manifest link,
// silently skipping injection here would deploy a broken PWA.
const PWA_MARKER = '<link rel="manifest" href="./manifest.json" />';
if (indexHtml.includes(PWA_MARKER)) {
  log("index.html: PWA tags already present, skipping injection");
} else {
  const faviconTag = '<link rel="icon" href="./favicon.png" />';
  if (!indexHtml.includes(faviconTag)) {
    die("favicon tag not found in index.html - injection anchor moved upstream");
  }
  indexHtml = indexHtml.replace(
    faviconTag,
    `${faviconTag}
    <link rel="manifest" href="./manifest.json" />
    <link rel="apple-touch-icon" sizes="180x180" href="./icons/apple-touch-icon.png" />
    <meta name="theme-color" content="#2f3437" />
    <meta name="description" content="Open-source E-book reader for all your files." />
    <script>
      if ("serviceWorker" in navigator) {
        // After a redeploy the new SW claims existing pages; reload once so
        // the document always runs against the assets its controlling SW
        // actually precached. First-visit installs never reload.
        var hadController = !!navigator.serviceWorker.controller;
        var reloading = false;
        navigator.serviceWorker.addEventListener("controllerchange", function () {
          if (hadController && !reloading) {
            reloading = true;
            window.location.reload();
          }
          hadController = true;
        });
        window.addEventListener("load", function () {
          navigator.serviceWorker
            // updateViaCache "none": never let the HTTP cache (Pages serves
            // sw.js with max-age=600) delay picking up a new deployment.
            .register("./sw.js", { scope: "./", updateViaCache: "none" })
            .catch(function (error) {
              console.error("SW registration failed", error);
            });
        });
      }
      // The whole library (book bytes, notes, config) lives in IndexedDB
      // under the shared github.io per-origin quota, competing with the SW
      // caches. Ask for persistent storage so quota pressure can't silently
      // evict the user's books.
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(function (granted) {
          console.info("Persistent storage granted:", granted);
        }, function () {});
      }
    </script>`
  );
}
// Hard assert: the deployment must never ship without the PWA wiring.
if (!indexHtml.includes(PWA_MARKER)) {
  die("PWA manifest link missing from index.html after injection");
}
if (!indexHtml.includes('register("./sw.js"')) {
  die("SW registration missing from index.html after injection");
}
fs.writeFileSync(indexPath, indexHtml);
log("index.html: PWA tags present");

// 6b. build the SW precache manifest from the built index.html + assets
const assetUrlsFromIndex = (html) => {
  const urls = new Set();
  const patterns = [/\ssrc="([^"]+)"/g, /\shref="([^"]+)"/g];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html))) {
      const url = m[1];
      if (url.startsWith("./")) urls.add(url);
    }
  }
  return [...urls];
};

const indexAssets = assetUrlsFromIndex(indexHtml);

// every file in static/ is fair game to precache (they're all app shell),
// plus locale chunks - find them by scanning static/ contents
const staticDir = path.join(BUILD, "static");
const staticFiles = fs.readdirSync(staticDir).map((f) => `./static/${f}`);

// lib/ scripts loaded by index.html (script tags above already captured
// them). Additional on-demand lib assets (wasm, cmaps, fonts, tesseract,
// onnx) stay runtime-cached, NOT precached - they're large and optional.
// theme.css IS startup-critical: initTheme() (launchUtil.ts) appends it on
// every cold boot, so an offline launch without it renders unstyled.
const precache = [
  ...new Set([
    "./",
    "./index.html",
    "./offline.html",
    "./manifest.json",
    "./assets/styles/theme.css",
    ...indexAssets,
    ...staticFiles.filter((u) => !indexAssets.includes(u)),
  ]),
];

const diskPathFor = (url) =>
  url === "./"
    ? path.join(BUILD, "index.html")
    : path.join(BUILD, url.replace(/^\.\//, ""));

// verify every precache URL is a real FILE on disk (existsSync alone would
// pass a directory, which fileDigest below then collapses to "missing" and
// two phantom entries would hash identically)
for (const url of precache) {
  const diskPath = diskPathFor(url);
  if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
    die(`precache URL is not a file on disk: ${url}`);
  }
}

const fileDigest = (p) => {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return "missing";
  }
};

// The SW template participates in the revision: a template-only change (no
// precache content change) must still rotate VERSION, otherwise clients
// re-download the new sw.js bytes but keep the SAME cache generation name -
// no copy-forward, and every redeploy after that re-fetches ~15 MB.
const swTemplate = fs.readFileSync(path.join(OVERLAY, "sw.js"), "utf8");

// Content-hash revision (NOT mtime): byte-identical rebuilds produce the
// same VERSION, so an unchanged weekly build neither reinstalls the SW nor
// makes clients re-download ~15 MB of precache.
const revision = createHash("sha256")
  .update(swTemplate)
  .update("\n")
  .update(precache.map((u) => u + ":" + fileDigest(diskPathFor(u))).join("|"))
  .digest("hex")
  .slice(0, 12);

// 6c. write sw.js with substituted manifest (replacer functions: with a
// plain string replacement, any $-sequence inside the substituted text -
// e.g. minified code in the precache JSON - would be interpreted as a
// replacement pattern)
const sw = swTemplate
  .replace("__SW_REVISION__", () => revision)
  .replace("__SW_SCOPE_PREFIX__", () => BASE_PATH)
  .replace("__PRECACHE_URLS__", () => JSON.stringify(precache));
fs.writeFileSync(path.join(BUILD, "sw.js"), sw);
log(`sw.js written (revision ${revision}, ${precache.length} precache URLs)`);

// ---------------------------------------------------------------------------
// 7. build artifact metadata (provenance)
// ---------------------------------------------------------------------------
// Deliberately NOT precached: the timestamp changes every build and must not
// churn the SW revision for a content-identical app shell.
const gitHead = (cwd) => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};
const upstreamCommit = gitHead(UPSTREAM);
fs.writeFileSync(
  path.join(BUILD, "build-info.json"),
  JSON.stringify(
    {
      revision,
      precacheEntries: precache.length,
      builtAt: new Date().toISOString(),
      upstream: {
        repository: "koodo-reader/koodo-reader",
        ref: "dev",
        commit: upstreamCommit,
      },
      deploy: {
        commit: process.env.GITHUB_SHA || gitHead(REPO),
        runId: process.env.GITHUB_RUN_ID || null,
      },
    },
    null,
    2
  )
);
log(`build-info.json written (upstream dev @ ${upstreamCommit || "unknown"})`);

log(`DONE. Artifact at ${BUILD}`);
