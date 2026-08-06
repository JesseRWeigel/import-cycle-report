/* Walking a source tree, and nothing else. */

import { readdirSync, statSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DEFAULT_IGNORES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  'vendor',
  'site-packages',
];

export const PY_EXT = ['.py', '.pyi'];
export const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** POSIX style relative id for a file, so ids are the same on any platform. */
export function toId(root, abs) {
  return relative(root, abs).split(sep).join('/');
}

/**
 * Every file under root with one of `exts`, as absolute paths, sorted.
 *
 * Symlinked directories are not followed. A tree with a symlink pointing at its own parent walks
 * forever, and a tree with a symlink to a sibling counts the same module under two ids, which
 * would invent cycles that are an artefact of the walk.
 */
export function walk(root, exts, ignores = DEFAULT_IGNORES) {
  const ignore = new Set(ignores);
  const found = [];
  const seenDirs = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let real;
    try {
      real = statSync(dir).ino + ':' + statSync(dir).dev;
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) continue;
        if (exts.some((e) => ent.name.endsWith(e))) found.push(p);
        continue;
      }
      if (ent.isDirectory()) {
        if (ignore.has(ent.name)) continue;
        if (ent.name.startsWith('.') && ent.name !== '.') continue;
        stack.push(p);
        continue;
      }
      if (!ent.isFile()) continue;
      if (exts.some((e) => ent.name.endsWith(e))) found.push(p);
    }
  }
  found.sort();
  return found;
}

/** Does this path exist as a regular file. */
export function isFile(p) {
  try {
    return lstatSync(p).isFile() || statSync(p).isFile();
  } catch {
    return false;
  }
}
