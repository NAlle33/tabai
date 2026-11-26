import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rm(fixture, { recursive: true, force: true }));
// Preserve line numbers while excluding fenced examples from both links and headings.
function prose(source) {
  let fence;
  return source.split(/\r?\n/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker) { fence = marker[1]; return ""; }
    return line;
  });
}

function anchors(lines) {
  const used = new Set();
  for (let i = 0; i < lines.length; i++) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(lines[i])?.[1]
      ?? (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) ? lines[i].trim() : undefined);
    if (!heading) continue;
    const text = heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/[`*~]/g, "");
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "").replace(/ /g, "-");
    let slug = base, n = 0;
    while (used.has(slug)) slug = `${base}-${++n}`;
    used.add(slug);
  }
  return used;
}

async function checkLinks(root, files) {
  const errors = [], cache = new Map();
  async function headings(path) {
    if (!cache.has(path)) cache.set(path, anchors(prose(await readFile(path, "utf8"))));
    return cache.get(path);
  }
  for (const file of files) {
    const path = resolve(root, file), lines = prose(await readFile(path, "utf8"));
    const references = new Map();
    const key = text => text.trim().replace(/\s+/g, " ").toLowerCase();
    const destination = /(?:<([^>]+)>|([^\s()]+(?:\([^()]*\)[^\s()]*)*))/;
    for (const line of lines) {
      const definition = /^ {0,3}\[([^\]]+)\]:\s*(.*)$/.exec(line);
      if (definition) {
        const target = destination.exec(definition[2]);
        if (target && !references.has(key(definition[1]))) references.set(key(definition[1]), target[1] ?? target[2]);
      }
    }
    async function validate(href, line) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
      try {
        const hash = href.indexOf("#"), fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
        const pathname = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split("?")[0]);
        const target = pathname ? resolve(dirname(path), pathname) : path;
        if (relative(root, target).split(sep)[0] === "plans") return;
        if (!existsSync(target)) throw new Error("target does not exist");
        if (fragment && !(await headings(target)).has(fragment)) throw new Error(`heading #${fragment} does not exist`);
      } catch (error) { errors.push(`${file}:${line}: ${href} — ${error.message}`); }
    }
    // Match across line wraps too. Mask examples and consumed links without changing offsets.
    const mask = text => text.replace(/[^\n]/g, " ");
    const body = lines.join("\n").replace(/(`+)([\s\S]*?)\1/g, mask);
    const inline = new RegExp(`!?\\[[^\\]]*\\]\\(\\s*${destination.source}(?:\\s+["'][^"']*["'])?\\s*\\)`, "g");
    for (const match of body.matchAll(inline)) {
      await validate(match[1] ?? match[2], body.slice(0, match.index).split("\n").length);
    }
    const remainingLines = body.replace(inline, mask).split("\n");
    for (let i = 0; i < remainingLines.length; i++) {
      const remaining = remainingLines[i];
      if (/^ {0,3}\[[^\]]+\]:/.test(remaining)) {
        const definition = /^ {0,3}\[([^\]]+)\]:/.exec(remaining);
        const href = references.get(key(definition[1]));
        if (href) await validate(href, i + 1);
        continue;
      }
      for (const match of remaining.matchAll(/!?\[([^\]]+)\](?:\[([^\]]*)\])?/g)) {
        const href = references.get(key(match[2] || match[1]));
        if (href) await validate(href, i + 1);
      }
    }
  }
  return errors;
}

async function markdownFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

// Exercise failure paths as well as the repository's currently valid links.
const fixture = await mkdtemp(join(tmpdir(), "tabai-doc-links-"));
try {
  await writeFile(join(fixture, "target.md"), "# Räksmörgås: en `rubrik`!\n# Dubblett\n# Dubblett\n~~~md\n# Dold\n~~~\n");
  await writeFile(join(fixture, "source.md"), [
    "[Swedish](target.md#räksmörgås-en-rubrik)", "[Duplicate](target.md#dubblett-1)",
    "[encoded](target.md#r%C3%A4ksm%C3%B6rg%C3%A5s-en-rubrik)",
    "[reference][r]", "[r]: <target.md#dubblett>", "[external](https://example.invalid/no)",
    "```md", "[example](missing.md)", "```", "[history](plans/missing.md)",
    "[missing](missing.md)", "[anchor](target.md#dold)",
    "[wrapped\nlabel](missing-too.md)",
  ].join("\n"));
  const errors = await checkLinks(fixture, ["source.md"]);
  assert.equal(errors.length, 3, errors.join("\n"));
  assert.match(errors[0], /source.md:11: missing.md/);
  assert.match(errors[1], /source.md:12: target.md#dold/);
  assert.match(errors[2], /source.md:13: missing-too.md/);
} finally { await rm(fixture, { recursive: true, force: true }); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["README.md", "CLAUDE.md", "AGENTS.md", ...(await markdownFiles(join(root, "docs"))).map(path => relative(root, path))];
const errors = await checkLinks(root, files);
stopWatchdog();
if (errors.length) {
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exitCode = 1;
} else console.log(`Documentation links: ${files.length} files checked, 0 broken links`);
