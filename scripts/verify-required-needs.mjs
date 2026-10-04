// Asserts that the `required` job in .github/workflows/ci.yml lists every
// other job in that file under `needs:`, and nothing else. Branch protection
// requires only `required`, so a job missing from its `needs:` would run but
// never block a merge.
//
// The parse is line-based and strict rather than a YAML parser (none is a
// dependency here): it accepts only the block style ci.yml is written in --
// two-space unquoted job keys under a top-level `jobs:` and a single
// block-sequence `needs:` on `required`, trailing `# comments` allowed -- and
// fails on any other shape instead of guessing, so a reformat cannot pass
// vacuously. Every finding names the line it concerns.
//
// Run: `node scripts/verify-required-needs.mjs [path-to-ci.yml]`.
// Exit 0 = needs is complete; exit 1 = a finding; exit 2 = an unreadable file
// or a layout the check does not accept.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGGREGATOR = "required";
const DEFAULT_WORKFLOW = ".github/workflows/ci.yml";

/** The workflow is not in the one layout this check accepts. */
export class LayoutError extends Error {}

const TRAILING_COMMENT = String.raw`\s*(?:#.*)?$`;
const TOP_LEVEL_KEY = /^[A-Za-z_][\w-]*:/;
const TOP_LEVEL_LINE = /^\S/;
const PLAIN_TOP_LEVEL_KEY = /^[A-Za-z_][\w-]*:(?:\s|$)/;
const JOBS_KEY = new RegExp(`^jobs:${TRAILING_COMMENT}`);
const JOBS_KEY_PREFIX = /^jobs\s*:/;
const JOB_KEY = new RegExp(`^ {2}([A-Za-z_][\\w-]*):${TRAILING_COMMENT}`);
const BODY_KEY_LINE = /^ {4}[^\s#]/;
// Only a plain key is accepted: a quoted, escaped, tagged, alias or merge key
// can resolve to `needs` without being spelled `needs`.
const BODY_KEY = /^ {4}[A-Za-z_][\w-]*:(?:\s|$)/;
const NEEDS_KEY = /^ {4}needs:(.*)$/;
const NEEDS_ITEM = new RegExp(`^ {6}- ([A-Za-z_][\\w-]*)${TRAILING_COMMENT}`);
const JOB_BODY = /^ {4}/;
const LIST_BODY = /^ {6}/;

// Characters a YAML 1.1 reader (or Python's splitlines) treats as a line
// break; splitting on `\n` alone would let a job hide inside one line.
const FOREIGN_BREAKS = new Set([0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);
const BLOCK_SCALAR = new RegExp(
  `^ *(?:- +)?[\\w.-]+:[ \\t]*[|>][+-]?[0-9]?[+-]?${TRAILING_COMMENT}`,
);

function isSkippable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function stripComment(value) {
  return value.replace(/(^|\s)#.*$/, "").trim();
}

function foreignBreakIndex(source) {
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (FOREIGN_BREAKS.has(code) || (code === 0x0d && source[i + 1] !== "\n")) return i;
  }
  return -1;
}

function splitLines(source) {
  const at = foreignBreakIndex(source);
  if (at !== -1) {
    const lineNo = source.slice(0, at).split("\n").length;
    const code = source.charCodeAt(at).toString(16).toUpperCase().padStart(4, "0");
    throw new LayoutError(`line ${lineNo}: unsupported line-break character U+${code}`);
  }
  return source.split(/\r?\n/);
}

const leadingSpaces = (line) => line.length - line.trimStart().length;
const spaces = (line) => /^ */.exec(line)[0].length;

/** Rejects tab indentation on every line that is not inside a block scalar. */
function assertSpaceIndents(lines) {
  let scalarIndent = -1;
  for (const [index, line] of lines.entries()) {
    if (scalarIndent >= 0 && (line.trim() === "" || spaces(line) > scalarIndent)) continue;
    scalarIndent = -1;
    if (isSkippable(line)) continue;
    if (leadingSpaces(line) !== spaces(line)) {
      throw new LayoutError(`line ${index + 1}: tab in indentation`);
    }
    if (BLOCK_SCALAR.test(line)) scalarIndent = spaces(line);
  }
}

/** Returns the index of the one plain top-level `jobs:` line. */
function jobsKeyIndex(lines) {
  let start = -1;
  for (const [index, line] of lines.entries()) {
    if (isSkippable(line) || !TOP_LEVEL_LINE.test(line)) continue;
    if (!PLAIN_TOP_LEVEL_KEY.test(line)) {
      throw new LayoutError(`line ${index + 1}: expected an unquoted top-level key, got: ${line}`);
    }
    if (!JOBS_KEY_PREFIX.test(line)) continue;
    if (start !== -1) throw new LayoutError(`line ${index + 1}: a second top-level \`jobs:\` key`);
    if (!JOBS_KEY.test(line)) {
      throw new LayoutError(`line ${index + 1}: \`jobs:\` must be a key on its own line`);
    }
    start = index;
  }
  if (start === -1) throw new LayoutError("no top-level `jobs:` key");
  return start;
}

/**
 * Returns `{ jobsLineNo, jobs }`, each job `{ id, lineNo, body }` with `body`
 * the `{ lineNo, text }` lines under its key. Throws on a line break other than
 * `\n` or `\r\n`, on tab indentation, on a top-level key that is not a single
 * plain `jobs:` or other plain key, on any line inside `jobs:` that is neither
 * a job key nor an indented job body line, and on a repeated job key.
 */
export function parseJobs(source) {
  const lines = splitLines(source);
  assertSpaceIndents(lines);
  const start = jobsKeyIndex(lines);

  const jobs = [];
  const seen = new Set();
  for (const [offset, text] of lines.slice(start + 1).entries()) {
    if (isSkippable(text)) continue;
    if (TOP_LEVEL_KEY.test(text)) break;
    const lineNo = start + offset + 2;
    const id = JOB_KEY.exec(text)?.[1];
    if (id) {
      if (seen.has(id)) throw new LayoutError(`line ${lineNo}: job \`${id}\` is defined twice`);
      seen.add(id);
      jobs.push({ id, lineNo, body: [] });
    } else if (jobs.length > 0 && JOB_BODY.test(text)) {
      jobs.at(-1).body.push({ lineNo, text });
    } else {
      throw new LayoutError(
        `line ${lineNo}: expected an unquoted two-space job key, got: ${text.trim()}`,
      );
    }
  }
  return { jobsLineNo: start + 1, jobs };
}

function assertPlainKeys(job) {
  for (const { lineNo, text } of job.body) {
    if (BODY_KEY_LINE.test(text) && !BODY_KEY.test(text)) {
      throw new LayoutError(
        `line ${lineNo}: expected an unquoted \`<key>:\` in job \`${job.id}\`, got: ${text.trim()}`,
      );
    }
  }
}

function needsHeader(job) {
  assertPlainKeys(job);
  const keys = job.body.filter(({ text }) => NEEDS_KEY.test(text));
  if (keys.length === 0) {
    throw new LayoutError(`line ${job.lineNo}: \`${job.id}\` has no \`needs:\` key`);
  }
  if (keys.length > 1) {
    throw new LayoutError(`line ${keys[1].lineNo}: \`${job.id}\` has a second \`needs:\` key`);
  }
  const [header] = keys;
  if (stripComment(NEEDS_KEY.exec(header.text)[1]) !== "") {
    throw new LayoutError(
      `line ${header.lineNo}: \`needs:\` must be a block list, one job per line`,
    );
  }
  return header;
}

/** Returns the `{ id, lineNo }` entries of the job's block-list `needs:`. */
export function parseNeeds(job) {
  const header = needsHeader(job);
  const needs = [];
  for (const { lineNo, text } of job.body.filter((line) => line.lineNo > header.lineNo)) {
    if (isSkippable(text)) continue;
    const id = NEEDS_ITEM.exec(text)?.[1];
    if (id) {
      needs.push({ id, lineNo });
    } else if (LIST_BODY.test(text)) {
      throw new LayoutError(`line ${lineNo}: unrecognised \`needs:\` entry: ${text.trim()}`);
    } else {
      break;
    }
  }
  return needs;
}

/**
 * Returns the problems with the aggregator's `needs:` in a workflow source,
 * each prefixed with the line it concerns; an empty array means it is
 * complete. Throws LayoutError on a shape it cannot parse.
 */
export function findNeedsProblems(source) {
  const { jobsLineNo, jobs } = parseJobs(source);
  const aggregator = jobs.find((job) => job.id === AGGREGATOR);
  if (!aggregator) throw new LayoutError(`line ${jobsLineNo}: no \`${AGGREGATOR}\` job`);

  const lanes = jobs.filter((job) => job.id !== AGGREGATOR);
  const laneIds = new Set(lanes.map((job) => job.id));
  const problems = [];
  const listed = new Set();
  for (const { id, lineNo } of parseNeeds(aggregator)) {
    if (listed.has(id)) problems.push(`line ${lineNo}: \`${id}\` is listed twice`);
    listed.add(id);
    if (id === AGGREGATOR) {
      problems.push(`line ${lineNo}: \`${AGGREGATOR}\` lists itself`);
    } else if (!laneIds.has(id)) {
      problems.push(`line ${lineNo}: \`${id}\` is not another job in this workflow`);
    }
  }
  for (const { id, lineNo } of lanes) {
    if (!listed.has(id)) {
      problems.push(`line ${lineNo}: job \`${id}\` is missing from \`${AGGREGATOR}.needs\``);
    }
  }
  if (lanes.length === 0) {
    problems.push(`line ${aggregator.lineNo}: \`${AGGREGATOR}\` has no jobs to aggregate`);
  }
  return problems;
}

/**
 * Reads a workflow as strict UTF-8, dropping one leading byte-order mark.
 * Throws on bytes that are not valid UTF-8, which a lenient decode would
 * replace with U+FFFD and so check a file other than the one on disk.
 */
export function readWorkflow(path) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readFileSync(path),
  );
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function main() {
  const file = resolve(process.cwd(), process.argv[2] ?? DEFAULT_WORKFLOW);
  let problems;
  try {
    problems = findNeedsProblems(readWorkflow(file));
  } catch (err) {
    console.error(`verify-required-needs cannot check ${file}:`);
    console.error(`  - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error(`verify-required-needs FAILED for ${file}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`verify-required-needs OK: \`${AGGREGATOR}\` needs every other job in ${file}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
