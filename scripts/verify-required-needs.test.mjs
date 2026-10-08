import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGGREGATOR, findNeedsProblems, parseJobs } from "./verify-required-needs.mjs";

// The checker is a byte copy of gubbi-web's scripts/check-required-needs.mjs,
// whose suite covers its behavior. Change it there and copy it here verbatim.
const CHECKER_SHA256 = "313159a5229289aef3e47c157cfc5a6f8ab8ba611cf63f69ab7ebaad6b631bb7";

describe("checker copy", () => {
  it("is byte-identical to the pinned canonical checker", () => {
    const bytes = readFileSync(new URL("./verify-required-needs.mjs", import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), CHECKER_SHA256);
  });
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
