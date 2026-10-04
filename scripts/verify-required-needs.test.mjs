import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGGREGATOR,
  LayoutError,
  findNeedsProblems,
  parseJobs,
  parseNeeds,
} from "./verify-required-needs.mjs";

const workflow = (jobs) => `name: CI\n\non:\n  push:\n\njobs:\n${jobs}`;

// Line numbers below count from `name: CI` = line 1; `jobs:` is line 6.
const COMPLETE = workflow(`  verify: # trailing comment on a job key
    name: lint
    runs-on: ubuntu-latest
    steps:
      - name: Script whose body looks like workflow keys
        run: |
          needs:
          - ghost

  # comment between jobs
  secret-scan:
    uses: ./.github/workflows/gitleaks.yml

  required:
    name: required
    if: \${{ always() }}
    needs: # trailing comment on needs
      - verify # trailing comment on an item

      # a comment inside the list
      - secret-scan
    steps:
      - run: true
`);

// A complete first `needs` hides an incomplete second one spelled as a quoted
// key; YAML resolves both keys to `needs` and keeps the last.
const QUOTED_SECOND_NEEDS = `name: CI
on: push
jobs:
  alpha:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
  beta:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
  required:
    runs-on: ubuntu-latest
    if: \${{ always() }}
    needs:
      - alpha
      - beta
    "needs":
      - alpha
    steps:
      - run: "true"
`;
const ESCAPED_SECOND_NEEDS = QUOTED_SECOND_NEEDS.replace('"needs":', '"ne\\x65ds":');

// Each hides a `ghost` job that YAML sees: inside one line behind a NEL or LS
// line break, or under a second top-level `jobs:` key.
const NEL_HIDDEN_JOB =
  'name: CI\non: push\njobs:\n  alpha:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\u0085  ghost:\u0085    runs-on: ubuntu-latest\u0085    steps:\u0085      - run: "true"\n  required:\n    runs-on: ubuntu-latest\n    if: ${{ always() }}\n    needs:\n      - alpha\n    steps:\n      - run: "true"\n';
const LS_HIDDEN_JOB =
  'name: CI\non: push\njobs:\n  alpha:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\u2028  ghost:\u2028    runs-on: ubuntu-latest\n  required:\n    runs-on: ubuntu-latest\n    if: ${{ always() }}\n    needs:\n      - alpha\n    steps:\n      - run: "true"\n';
const SECOND_JOBS_KEY =
  'name: CI\non: push\njobs:\n  alpha:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n  required:\n    runs-on: ubuntu-latest\n    if: ${{ always() }}\n    needs:\n      - alpha\n    steps:\n      - run: "true"\njobs:\n  alpha:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n  ghost:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n  required:\n    runs-on: ubuntu-latest\n    if: ${{ always() }}\n    needs:\n      - alpha\n    steps:\n      - run: "true"\n';

const beforeAggregatorSteps = (lines) =>
  COMPLETE.replace("    steps:\n      - run: true\n", `${lines}    steps:\n      - run: true\n`);

const BLOCK_NEEDS = /^ {4}needs:.*\n(?:(?: {6}.*)?\n)+/m;

describe("findNeedsProblems", () => {
  it("accepts a needs list naming every other job, with comments, blank lines and run bodies", () => {
    assert.deepEqual(findNeedsProblems(COMPLETE), []);
  });

  it("accepts CRLF line endings and tabs inside a run body", () => {
    const source = COMPLETE.replace(
      "          - ghost\n",
      "          - ghost\n          \tprintf tab\n",
    );
    assert.deepEqual(findNeedsProblems(source.replace(/\n/g, "\r\n")), []);
  });

  it("reports a job missing from needs at the job declaration", () => {
    const source = COMPLETE.replace("      - secret-scan\n", "");
    assert.deepEqual(findNeedsProblems(source), [
      "line 17: job `secret-scan` is missing from `required.needs`",
    ]);
  });

  it("reports a needs entry that is not a job at the entry", () => {
    const source = COMPLETE.replace("      - secret-scan\n", "      - secret-scan\n      - gone\n");
    assert.deepEqual(findNeedsProblems(source), [
      "line 28: `gone` is not another job in this workflow",
    ]);
  });

  it("reports a duplicate needs entry at the second listing", () => {
    const source = COMPLETE.replace(
      "      - secret-scan\n",
      "      - secret-scan\n      - verify\n",
    );
    assert.deepEqual(findNeedsProblems(source), ["line 28: `verify` is listed twice"]);
  });

  it("reports the aggregator listing itself", () => {
    const source = COMPLETE.replace(
      "      - secret-scan\n",
      "      - secret-scan\n      - required\n",
    );
    assert.deepEqual(findNeedsProblems(source), ["line 28: `required` lists itself"]);
  });

  it("locates each needs entry at its own line", () => {
    const job = parseJobs(COMPLETE).jobs.find(({ id }) => id === AGGREGATOR);
    assert.deepEqual(parseNeeds(job), [
      { id: "verify", lineNo: 24 },
      { id: "secret-scan", lineNo: 27 },
    ]);
  });

  it("reports an aggregator with nothing to aggregate at its declaration", () => {
    const source = workflow("  required:\n    needs:\n    steps:\n      - run: true\n");
    assert.deepEqual(findNeedsProblems(source), ["line 7: `required` has no jobs to aggregate"]);
  });

  describe("fails closed on shapes it does not parse", () => {
    const cases = [
      {
        name: "flow-style needs",
        source: COMPLETE.replace(BLOCK_NEEDS, "    needs: [verify, secret-scan]\n"),
        error: /^line 23: `needs:` must be a block list/,
      },
      {
        name: "flow-style needs with a trailing comment",
        source: COMPLETE.replace(BLOCK_NEEDS, "    needs: [verify, secret-scan] # all\n"),
        error: /^line 23: `needs:` must be a block list/,
      },
      {
        name: "scalar needs",
        source: COMPLETE.replace(BLOCK_NEEDS, "    needs: verify\n"),
        error: /^line 23: `needs:` must be a block list/,
      },
      {
        name: "a second needs key after a complete first list",
        source: COMPLETE.replace(
          "    steps:\n      - run: true\n",
          "    needs:\n      - verify\n    steps:\n      - run: true\n",
        ),
        error: /^line 28: `required` has a second `needs:` key/,
      },
      {
        name: "a second, quoted needs key",
        source: COMPLETE.replace(
          "    steps:\n      - run: true\n",
          "    'needs':\n      - verify\n    steps:\n      - run: true\n",
        ),
        error: /^line 28: expected an unquoted `<key>:` in job `required`/,
      },
      {
        name: "a quoted needs key",
        source: COMPLETE.replace("    needs: # trailing", '    "needs": # trailing'),
        error: /^line 23: expected an unquoted `<key>:` in job `required`/,
      },
      {
        name: "a quoted second needs key after a complete first list",
        source: QUOTED_SECOND_NEEDS,
        error: /^line 18: expected an unquoted `<key>:` in job `required`/,
      },
      {
        name: "an escaped second needs key after a complete first list",
        source: ESCAPED_SECOND_NEEDS,
        error: /^line 18: expected an unquoted `<key>:` in job `required`/,
      },
      {
        name: "a tagged key in the aggregator",
        source: beforeAggregatorSteps("    !!str needs:\n      - verify\n"),
        error: /^line 28: expected an unquoted `<key>:` in job `required`/,
      },
      {
        name: "an alias key in the aggregator",
        source: beforeAggregatorSteps("    *needs_key :\n      - verify\n"),
        error: /^line 28: expected an unquoted `<key>:` in job `required`/,
      },
      {
        name: "a merge key in the aggregator",
        source: beforeAggregatorSteps("    <<: *partial_needs\n"),
        error: /^line 28: expected an unquoted `<key>:` in job `required`/,
      },
      {
        name: "a workflow without the aggregator",
        source: workflow("  verify:\n    runs-on: ubuntu-latest\n"),
        error: /^line 6: no `required` job/,
      },
      {
        name: "a quoted job key after a normal job",
        source: COMPLETE.replace("  secret-scan:\n", '  "secret-scan":\n'),
        error: /^line 17: expected an unquoted two-space job key/,
      },
      {
        name: "a single-quoted job key after a normal job",
        source: COMPLETE.replace("  secret-scan:\n", "  'secret-scan':\n"),
        error: /^line 17: expected an unquoted two-space job key/,
      },
      {
        name: "a job-indent line that is not a key",
        source: COMPLETE.replace("  # comment between jobs\n", "  - stray\n"),
        error: /^line 16: expected an unquoted two-space job key/,
      },
      {
        name: "a quoted needs item",
        source: COMPLETE.replace("      - secret-scan\n", '      - "secret-scan"\n'),
        error: /^line 27: unrecognised `needs:` entry/,
      },
      {
        name: "a job id at an unexpected indent",
        source: COMPLETE.replace("  secret-scan:\n", "   secret-scan:\n"),
        error: /^line 17: expected an unquoted two-space job key/,
      },
      {
        name: "an aggregator without a needs key",
        source: workflow("  verify:\n    runs-on: x\n  required:\n    runs-on: x\n"),
        error: /^line 9: `required` has no `needs:` key/,
      },
      {
        name: "a job defined twice",
        source: COMPLETE.replace("  # comment between jobs\n", "  verify:\n"),
        error: /^line 16: job `verify` is defined twice/,
      },
      {
        name: "a job hidden behind a NEL line break",
        source: NEL_HIDDEN_JOB,
        error: /^line 7: unsupported line-break character U\+0085/,
      },
      {
        name: "a job hidden behind an LS line break",
        source: LS_HIDDEN_JOB,
        error: /^line 7: unsupported line-break character U\+2028/,
      },
      {
        name: "a PS line break",
        source: COMPLETE.replace("      - secret-scan\n", "      - secret-scan\u2029"),
        error: /^line 27: unsupported line-break character U\+2029/,
      },
      {
        name: "a lone carriage return",
        source: COMPLETE.replace("      - secret-scan\n", "      - secret-scan\r"),
        error: /^line 27: unsupported line-break character U\+000D/,
      },
      {
        name: "tab indentation",
        source: COMPLETE.replace("    if: ${{", "\tif: ${{"),
        error: /^line 22: tab in indentation/,
      },
      {
        name: "a second top-level `jobs:` key",
        source: SECOND_JOBS_KEY,
        error: /^line 15: a second top-level `jobs:` key/,
      },
      {
        name: "a quoted top-level `jobs:` key",
        source: COMPLETE.replace("jobs:\n", '"jobs":\n'),
        error: /^line 6: expected an unquoted top-level key/,
      },
      {
        name: "an escaped second top-level `jobs:` key",
        source: `${COMPLETE}"j\\x6fbs":\n  ghost:\n    runs-on: x\n`,
        error: /^line 30: expected an unquoted top-level key/,
      },
      {
        name: "a workflow without `jobs:`",
        source: "name: CI\non:\n  push:\n",
        error: /^no top-level `jobs:` key/,
      },
    ];
    for (const { name, source, error } of cases) {
      it(`rejects ${name}`, () => {
        assert.throws(
          () => findNeedsProblems(source),
          (err) => err instanceof LayoutError && error.test(err.message),
        );
      });
    }
  });
});

// Valid apart from the stray 0xFF byte in the first line's comment.
const MALFORMED_UTF8 = Buffer.concat([
  Buffer.from("name: CI # "),
  Buffer.from([0xff]),
  Buffer.from(
    '\non: push\njobs:\n  alpha:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' +
      '  required:\n    needs:\n      - alpha\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n',
  ),
]);

describe("exit status", () => {
  const checker = fileURLToPath(new URL("./verify-required-needs.mjs", import.meta.url));
  const run = (source) => {
    const dir = mkdtempSync(join(tmpdir(), "required-needs-"));
    try {
      const path = join(dir, "ci.yml");
      if (source !== null) writeFileSync(path, source);
      return spawnSync(process.execPath, [checker, path], { encoding: "utf8" }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const cases = [
    { name: "complete needs", source: COMPLETE, status: 0 },
    {
      name: "complete needs behind a UTF-8 byte-order mark",
      source: `\uFEFF${COMPLETE}`,
      status: 0,
    },
    { name: "malformed UTF-8", source: MALFORMED_UTF8, status: 2 },
    { name: "a finding", source: COMPLETE.replace("      - secret-scan\n", ""), status: 1 },
    {
      name: "a layout error",
      source: COMPLETE.replace("  secret-scan:\n", '  "secret-scan":\n'),
      status: 2,
    },
    { name: "a quoted second needs key", source: QUOTED_SECOND_NEEDS, status: 2 },
    { name: "an escaped second needs key", source: ESCAPED_SECOND_NEEDS, status: 2 },
    { name: "a job hidden behind a NEL line break", source: NEL_HIDDEN_JOB, status: 2 },
    { name: "a job hidden behind an LS line break", source: LS_HIDDEN_JOB, status: 2 },
    { name: "a second top-level jobs key", source: SECOND_JOBS_KEY, status: 2 },
    { name: "an unreadable file", source: null, status: 2 },
  ];
  for (const { name, source, status } of cases) {
    it(`exits ${status} on ${name}`, () => {
      assert.equal(run(source), status);
    });
  }
});

const CI_PATH = ".github/workflows/ci.yml";
const CHECKER_STEP = "needs lists every other job";
const VERDICT_STEP = "Every required job succeeded";
const CHECKER_COMMAND = ["node", "scripts/verify-required-needs.mjs", CI_PATH];

const STEP_START = /^ {6}- (.*)$/;
const STEP_KEY = /^ {8}([\w-]+):\s*(.*)$/;
const WITH_KEY = /^ {10}([\w-]+):\s*(.*)$/;

/** Reads the aggregator's steps from ci.yml as `{ fields, with, run }` records. */
function aggregatorSteps(job) {
  const at = job.body.findIndex(({ text }) => /^ {4}steps:\s*$/.test(text));
  assert.notEqual(at, -1, "`required` has no `steps:`");
  const steps = [];
  let section = null;
  for (const { text } of job.body.slice(at + 1)) {
    if (text.trim() === "") continue;
    if (!/^ {6}/.test(text)) break;
    const start = STEP_START.exec(text);
    const line = start ? `        ${start[1]}` : text;
    if (start) steps.push({ fields: new Map(), with: new Map(), run: [] });
    const step = steps.at(-1);
    const key = STEP_KEY.exec(line);
    const withKey = WITH_KEY.exec(line);
    if (key) {
      section = key[1];
      step.fields.set(key[1], key[2].replace(/\s+#.*$/, ""));
      if (key[1] === "run" && key[2] !== "|") step.run.push(key[2]);
    } else if (section === "with" && withKey) {
      step.with.set(withKey[1], withKey[2].replace(/\s+#.*$/, ""));
    } else if (section === "run") {
      step.run.push(line.trim());
    }
  }
  return steps;
}

describe("ci.yml wiring", () => {
  const ciPath = fileURLToPath(new URL(`../${CI_PATH}`, import.meta.url));
  const source = readFileSync(ciPath, "utf8");
  const job = parseJobs(source).jobs.find(({ id }) => id === AGGREGATOR);
  const steps = aggregatorSteps(job);
  const indexOf = (predicate, what) => {
    const index = steps.findIndex(predicate);
    assert.notEqual(index, -1, `\`required\` has no ${what} step`);
    return index;
  };

  it("the checked-in ci.yml passes the check", () => {
    assert.deepEqual(findNeedsProblems(source), []);
  });

  it("the needs step runs exactly the checker on ci.yml, after checkout and before the verdict", () => {
    const checkout = indexOf(
      (step) => step.fields.get("uses")?.startsWith("actions/checkout@"),
      "checkout",
    );
    const checker = indexOf((step) => step.fields.get("name") === CHECKER_STEP, "checker");
    const verdict = indexOf((step) => step.fields.get("name") === VERDICT_STEP, "verdict");

    assert.deepEqual(
      steps[checker].run.map((line) => line.split(/\s+/)),
      [CHECKER_COMMAND],
    );
    assert.ok(checkout < checker && checker < verdict, "step order");
  });

  it("the needs step cannot be skipped or allowed to fail", () => {
    const checker = steps.find((step) => step.fields.get("name") === CHECKER_STEP);
    assert.equal(checker.fields.has("if"), false);
    assert.equal(checker.fields.has("continue-on-error"), false);
  });

  it("the job is bounded and its checkout keeps no credentials", () => {
    assert.ok(job.body.some(({ text }) => /^ {4}timeout-minutes: 5\s*$/.test(text)));
    const checkout = steps.find((step) => step.fields.get("uses")?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.get("persist-credentials"), "false");
  });
});
