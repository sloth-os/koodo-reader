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
 *   3. copy overlay/ files in (manifest, sw, offline page, icons, module)
 *   4. patch the vendored kookit bundle for subpath hosting (exact-string
 *      replacements, asserted)
 *   5. vite build
 *   6. post-process build/: inject manifest/SW tags into index.html,
 *      generate the SW precache manifest, substitute it into sw.js
 *   7. write build artifact metadata
 *
 * Usage: node scripts/build.mjs [--upstream <path>] [--out <path>]
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

const WEB_BASE_HELPER =
  'const koodoWebBase=()=>{try{return new URL(".",document.baseURI).pathname}catch(e){return"."}};';

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
if (!indexHtml.includes("manifest.json")) {
  const faviconTag = '<link rel="icon" href="./favicon.png" />';
  if (!indexHtml.includes(faviconTag)) die("favicon tag not found in index.html");
  indexHtml = indexHtml.replace(
    faviconTag,
    `${faviconTag}
    <link rel="manifest" href="./manifest.json" />
    <meta name="theme-color" content="#2f3437" />
    <meta name="description" content="Open-source E-book reader for all your files." />
    <script>
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", function () {
          navigator.serviceWorker
            .register("./sw.js", { scope: "./" })
            .catch(function (error) {
              console.error("SW registration failed", error);
            });
        });
      }
    </script>`
  );
  fs.writeFileSync(indexPath, indexHtml);
  log("index.html: PWA tags injected");
}

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
const precache = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.json",
  ...indexAssets,
  ...staticFiles.filter((u) => !indexAssets.includes(u)),
];

// verify every precache URL exists on disk
for (const url of precache) {
  if (url === "./") continue;
  const diskPath = path.join(BUILD, url.replace("./", ""));
  if (!fs.existsSync(diskPath)) {
    die(`precache URL does not exist on disk: ${url}`);
  }
}

const revision = createHash("sha256")
  .update(
    precache
      .map((u) => {
        const p = u === "./" ? path.join(BUILD, "index.html") : path.join(BUILD, u.replace("./", ""));
        try {
          return u + ":" + fs.statSync(p).size + ":" + fs.statSync(p).mtimeMs;
        } catch {
          return u;
        }
      })
      .join("|")
  )
  .digest("hex")
  .slice(0, 12);

// 6c. write sw.js with substituted manifest
let sw = fs.readFileSync(path.join(OVERLAY, "sw.js"), "utf8");
sw = sw
  .replace("__SW_REVISION__", revision)
  .replace("__SW_SCOPE_PREFIX__", BASE_PATH)
  .replace("__PRECACHE_URLS__", JSON.stringify(precache));
fs.writeFileSync(path.join(BUILD, "sw.js"), sw);
log(`sw.js written (revision ${revision}, ${precache.length} precache URLs)`);

log(`DONE. Artifact at ${BUILD}`);
