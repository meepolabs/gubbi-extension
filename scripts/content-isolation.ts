import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { Plugin, Rollup } from "vite";

// Content-script isolation gate (privacy boundary). Rebuilt for WXT from the
// former standalone scripts/check-content-isolation.mjs.
//
// Why a build-graph check and not just lint: the ESLint rule on the content
// entrypoints bans bare import specifiers in the SOURCE, but a relative import
// there (e.g. "../../src/lib/foo") can transitively pull a package into the
// bundle. Tree-shaking also means the emitted chunk's import specifiers are all
// relative, so the emitted text cannot tell you whether third-party code was
// inlined. The only reliable signal is Rollup's module graph: every output
// chunk records the source-module ids it was built from (chunk.modules). This
// plugin runs inside the WXT build, walks the graph from each content-script
// entry, and fails if any reachable module resolves under node_modules EXCEPT a
// pinned allowlist of `wxt` and `@wxt-dev/*` (WXT injects its own runtime --
// ContentScriptContext, an internal logger, and @wxt-dev/browser when `browser`
// is imported -- into every content bundle; everything else is banned).
//
// The exact set of allowlisted wxt-internal modules is frozen per browser in a
// committed snapshot under content-isolation/. A drift (an unexpected new
// wxt-internal import) fails the build so it is caught in review. A MISSING
// snapshot also hard-fails the build rather than silently recreating one, so a
// deleted privacy baseline cannot pass unnoticed; regenerate intentionally with
// WXT_ISOLATION_UPDATE=1.

const SNAPSHOT_DIR = "content-isolation";
const NODE_MODULES = "/node_modules/";
const ALLOWED_PACKAGES = ["wxt", "@wxt-dev/"];

interface PluginOptions {
  readonly contentInputPaths: readonly string[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

// Rollup module ids may carry a leading NUL (virtual modules) and a query
// suffix; normalize to a comparable filesystem-style path.
function normalizeId(id: string): string {
  const noNul = id.startsWith("\0") ? id.slice(1) : id;
  const noQuery = noNul.split("?")[0] ?? noNul;
  return toPosix(noQuery);
}

// Path relative to the last node_modules segment, e.g.
// ".../node_modules/.pnpm/wxt@x/node_modules/wxt/dist/a.js" -> "wxt/dist/a.js".
// Stable across machines (no absolute/home prefix) and pnpm store layout.
function relAfterNodeModules(posixPath: string): string {
  const idx = posixPath.lastIndexOf(NODE_MODULES);
  return idx === -1 ? posixPath : posixPath.slice(idx + NODE_MODULES.length);
}

function packageOf(relPath: string): string {
  const parts = relPath.split("/");
  if (relPath.startsWith("@")) {
    const scope = parts[0] ?? "";
    const name = parts[1] ?? "";
    return `${scope}/${name}`;
  }
  return parts[0] ?? relPath;
}

function isAllowedPackage(relPath: string): boolean {
  const pkg = packageOf(relPath);
  return ALLOWED_PACKAGES.some((allowed) =>
    allowed.endsWith("/") ? pkg.startsWith(allowed) : pkg === allowed,
  );
}

// chrome-mv3 / firefox-mv3 from the resolved output directory.
function browserKeyFromOutDir(outDir: string): string {
  const posix = toPosix(outDir);
  if (posix.includes("firefox")) return "firefox-mv3";
  if (posix.includes("chrome")) return "chrome-mv3";
  return basename(posix);
}

function chunkContainsInput(chunk: Rollup.OutputChunk, inputPath: string): boolean {
  const target = toPosix(inputPath);
  return Object.keys(chunk.modules).some((moduleId) => normalizeId(moduleId) === target);
}

function reachableFileNames(
  entryFileNames: readonly string[],
  byFileName: Map<string, Rollup.OutputChunk>,
): Set<string> {
  const reachable = new Set<string>();
  const stack = [...entryFileNames];
  while (stack.length > 0) {
    const fileName = stack.pop();
    if (fileName === undefined || reachable.has(fileName)) continue;
    reachable.add(fileName);
    const chunk = byFileName.get(fileName);
    if (!chunk) continue;
    for (const dep of [...chunk.imports, ...chunk.dynamicImports]) stack.push(dep);
  }
  return reachable;
}

interface SnapshotResult {
  readonly action: "wrote" | "matched" | "missing";
  readonly drift?: { readonly added: string[]; readonly removed: string[] };
}

// Runtime-guarded read of a committed snapshot. A corrupted or hand-edited file
// must not throw an opaque TypeError; anything that is not { allowlist: [...] }
// degrades to an empty allowlist (which then surfaces as drift).
function readAllowlist(file: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const allowlist = (parsed as { allowlist?: unknown } | null)?.allowlist;
  return Array.isArray(allowlist)
    ? allowlist.filter((m): m is string => typeof m === "string")
    : [];
}

function reconcileSnapshot(rootDir: string, browserKey: string, modules: string[]): SnapshotResult {
  const file = resolve(rootDir, SNAPSHOT_DIR, `${browserKey}.snapshot.json`);
  const sorted = [...modules].sort();
  const update = process.env.WXT_ISOLATION_UPDATE === "1";

  if (update) {
    const payload = `${JSON.stringify({ allowlist: sorted }, null, 2)}\n`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, payload);
    return { action: "wrote" };
  }

  // Missing snapshot is a hard failure unless the update flag was set above: a
  // silent recreate would let a deleted privacy baseline pass review unnoticed.
  if (!existsSync(file)) {
    return { action: "missing" };
  }

  const before = new Set(readAllowlist(file));
  const after = new Set(sorted);
  const added = sorted.filter((m) => !before.has(m));
  const removed = [...before].filter((m) => !after.has(m)).sort();
  return { action: "matched", drift: { added, removed } };
}

export function contentIsolationPlugin(options: PluginOptions): Plugin {
  let outDir = ".output";
  const rootDir = process.cwd();

  return {
    name: "gubbi:content-isolation",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_outputOptions, bundle) {
      const browserKey = browserKeyFromOutDir(outDir);
      const chunks: Rollup.OutputChunk[] = Object.values(bundle).filter(
        (item): item is Rollup.OutputChunk => item.type === "chunk",
      );
      const byFileName = new Map(chunks.map((c) => [c.fileName, c]));

      // Loud-fail guard: every content entry this build was asked to isolate
      // MUST appear in the graph, or the gate is inspecting nothing.
      const missing = options.contentInputPaths.filter(
        (inputPath) => !chunks.some((c) => chunkContainsInput(c, inputPath)),
      );
      if (missing.length > 0) {
        this.error(
          `content-isolation gate FAILED for ${browserKey}: content entries not found ` +
            `in the build graph:\n  ${missing.join("\n  ")}`,
        );
      }

      // Entry chunks from which a content entry is reachable. Inspecting only
      // these avoids flagging a sibling background/popup bundle's legitimate
      // third-party imports when WXT groups builds.
      const entryReachesContent = (entryFileName: string): boolean => {
        const reachableSet = reachableFileNames([entryFileName], byFileName);
        return [...reachableSet].some((fn) => {
          const dep = byFileName.get(fn);
          return dep
            ? options.contentInputPaths.some((inputPath) => chunkContainsInput(dep, inputPath))
            : false;
        });
      };

      const entryFileNames = chunks
        .filter((c) => c.isEntry && entryReachesContent(c.fileName))
        .map((c) => c.fileName);

      if (entryFileNames.length === 0) {
        this.error(
          `content-isolation gate FAILED for ${browserKey}: no content entry chunk located.`,
        );
      }

      const reachable = reachableFileNames(entryFileNames, byFileName);
      const offenders: string[] = [];
      const allowed = new Set<string>();
      for (const fileName of reachable) {
        const chunk = byFileName.get(fileName);
        if (!chunk) continue;
        for (const moduleId of Object.keys(chunk.modules)) {
          const posix = normalizeId(moduleId);
          if (!posix.includes(NODE_MODULES)) continue;
          const relPath = relAfterNodeModules(posix);
          if (isAllowedPackage(relPath)) allowed.add(relPath);
          else offenders.push(`${fileName} <- node_modules/${relPath}`);
        }
      }

      if (offenders.length > 0) {
        this.error(
          `content-isolation gate FAILED for ${browserKey}: third-party code reached a ` +
            `content bundle:\n  ${[...new Set(offenders)].sort().join("\n  ")}`,
        );
      }

      const snapshot = reconcileSnapshot(rootDir, browserKey, [...allowed]);
      if (snapshot.action === "missing") {
        this.error(
          `content-isolation snapshot missing for ${browserKey}; regenerate explicitly ` +
            `with WXT_ISOLATION_UPDATE=1`,
        );
      }
      if (snapshot.action === "matched" && snapshot.drift) {
        const { added, removed } = snapshot.drift;
        if (added.length > 0 || removed.length > 0) {
          this.error(
            `content-isolation gate FAILED for ${browserKey}: wxt-internal allowlist drifted ` +
              `from the committed snapshot. Review, then re-run with WXT_ISOLATION_UPDATE=1.\n` +
              (added.length ? `  added:\n    ${added.join("\n    ")}\n` : "") +
              (removed.length ? `  removed:\n    ${removed.join("\n    ")}` : ""),
          );
        }
      }

      this.info(
        `content-isolation gate OK for ${browserKey}: ${entryFileNames.length} content ` +
          `entr${entryFileNames.length === 1 ? "y" : "ies"}, ${reachable.size} reachable ` +
          `chunk(s), ${allowed.size} wxt-internal module(s) allowlisted, 0 third-party ` +
          `(snapshot ${snapshot.action}).`,
      );
    },
  };
}
