import assert from "node:assert/strict";
import test from "node:test";
import {
  RESOURCE_LEXICON,
  findGatherVerb,
  findResourceMatches,
  normalizePrefab,
} from "../src/shared/resource-lexicon.js";

test("gather verbs map to the right mode and prefer the longest verb", () => {
  assert.equal(findGatherVerb("砍那棵树")?.mode, "chop");
  assert.equal(findGatherVerb("挖石头")?.mode, "mine");
  assert.equal(findGatherVerb("采矿石")?.mode, "mine");
  // A generic collect verb leaves the mode to the resource default (undefined).
  assert.equal(findGatherVerb("采浆果")?.mode, undefined);
  assert.equal(findGatherVerb("收集干草")?.mode, undefined);
  assert.equal(findGatherVerb("你好世界"), undefined);
});

test("resource matching tolerates ASR homophones", () => {
  for (const spoken of ["浆果", "姜果", "桨果", "僵果", "莓果"]) {
    const matches = findResourceMatches(spoken);
    assert.equal(matches.length, 1, `expected a berries match for ${spoken}`);
    assert.equal(matches[0]!.resource.name, "berries");
  }
});

test("the longest resource token wins so 树枝 is twigs and bare 树 is a tree", () => {
  const twigs = findResourceMatches("摘树枝");
  assert.equal(twigs.length, 1);
  assert.equal(twigs[0]!.resource.name, "twigs");

  const tree = findResourceMatches("砍树", "chop");
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.resource.name, "tree");
});

test("an explicit verb mode overrides the resource default mode", () => {
  const verb = findGatherVerb("砍树");
  const matches = findResourceMatches("砍树", verb?.mode);
  assert.equal(matches[0]!.mode, "chop");

  const mineVerb = findGatherVerb("挖石头");
  const mineMatches = findResourceMatches("挖石头", mineVerb?.mode);
  assert.equal(mineMatches[0]!.resource.name, "rock");
  assert.equal(mineMatches[0]!.mode, "mine");
});

test("two distinct resources in one utterance are reported separately for the router to block", () => {
  const matches = findResourceMatches("采草和树枝");
  const names = matches.map((match) => match.resource.name).sort();
  assert.deepEqual(names, ["grass", "twigs"]);
});

test("every lexicon prefab canonicalizes to a lowercase underscore form", () => {
  for (const resource of RESOURCE_LEXICON) {
    for (const prefab of resource.prefabs) {
      assert.equal(prefab, normalizePrefab(prefab));
    }
  }
});
