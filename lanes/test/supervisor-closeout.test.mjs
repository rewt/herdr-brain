import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "supervisor");
const latest = readdirSync(root).filter((name) => /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(name)).sort().at(-1);
const read = (name) => readFileSync(join(root, latest, name), "utf8");

test("supervisor closeout pack wires instructions and verifies every release digest", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.protocol, latest);
  assert.ok(manifest.files.includes("CLOSEOUT.md"));
  assert.match(read("STARTER.md"), /CLOSEOUT\.md/);
  assert.match(read("README.md"), /CLOSEOUT\.md/);
  assert.match(read("ENGINEER_REPORT_APPENDIX.md"), /Do not close your own/);
  assert.match(read("PROJECT_TEMPLATE.md"), /Promotion and close authority/);
  assert.match(read("TODAY_TEMPLATE.md"), /Closeout state/);
  const digests = JSON.parse(read("SHA256.json"));
  assert.deepEqual(Object.keys(digests).sort(), [...manifest.files, "manifest.json"].sort());
  for (const [name, digest] of Object.entries(digests)) {
    assert.equal(createHash("sha256").update(read(name)).digest("hex"), digest, name);
  }
  if (process.env.LANE_TEST_NEGATIVE_CONTROL === "1") assert.fail("closeout release wiring control");
});

test("supervisor closeout separates acceptance, promotion, removal, and recovery", () => {
  const protocol = read("CLOSEOUT.md");
  const stages = ["## Accept the handoff", "## Promote once", "## Close and verify", "## Record the outcome"];
  let previous = -1;
  for (const stage of stages) {
    const offset = protocol.indexOf(stage);
    assert.ok(offset > previous, `missing or out-of-order stage: ${stage}`);
    previous = offset;
  }
  for (const requirement of [
    /Do not ask again for approval already granted/,
    /Git common directory/,
    /independent review/,
    /untracked public review record/,
    /cd "\$canonical_checkout"/,
    /lane promote "\$topic"/,
    /lane close "\$topic"/,
    /main moved|main has moved/,
    /Do not close after failed promotion/,
    /promoted-cleanup-pending/,
    /lane closed; metadata update failed/,
    /herdr workspace close "\$workspace_id"/,
    /replacement occupant/,
    /supervisor's own/,
    /Never use `--force`/,
    /does not terminate/,
    /Do not retry lifecycle commands/,
  ]) assert.match(protocol, requirement);
  if (process.env.LANE_TEST_NEGATIVE_CONTROL === "1") assert.fail("closeout boundary control");
});
