import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { IngestConversationRequestSchema } from "../../src/lib/schema/ingest";

// The fixture is a byte copy of the backend's generated ingest contract, whose
// own suite checks every verdict against the server's request model. Regenerate
// it there, copy it here byte for byte, then update FIXTURE_SHA256.
const FIXTURE_SHA256 = "ff6299e077ea5a36c2b16632cbe7f8941ae5e22ebd766049a2c644ef40686391";
const FIXTURE_ROW_COUNT = 133;

interface ContractRow {
  name: string;
  covers: string[];
  payload: unknown;
  valid: boolean;
}

const fixtureBytes = readFileSync(new URL("../fixtures/ingest-contract.json", import.meta.url));
const rows = (JSON.parse(fixtureBytes.toString("utf8")) as { rows: ContractRow[] }).rows;

describe("ingest contract fixture copy", () => {
  it("is byte-identical to the pinned backend fixture", () => {
    expect(
      createHash("sha256").update(fixtureBytes).digest("hex"),
      "tests/fixtures/ingest-contract.json differs from the backend's generated fixture; " +
        "copy it here byte for byte, then update FIXTURE_SHA256",
    ).toBe(FIXTURE_SHA256);
  });

  it("holds every contract row", () => {
    expect(rows).toHaveLength(FIXTURE_ROW_COUNT);
  });
});

describe("ingest request schema verdict matches the backend", () => {
  it.each(rows)("$name", ({ payload, valid }) => {
    expect(IngestConversationRequestSchema.safeParse(payload).success).toBe(valid);
  });
});
