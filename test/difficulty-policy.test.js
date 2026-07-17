'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  effortMagnitude,
  difficultyCandidates,
  parseDifficultyScaling,
} = require('../src/difficulty-policy');
const { defaultEffortProfile } = require('../src/effort');
const { estimatedCostUsd, effectiveRounds } = require('../src/budget');
const { resolveDifficultyEffort } = require('../src/run');

// The most expensive candidate in a ladder — the difficulty-proposed CEILING, which chooseProfile picks
// when no budget cap binds. defaultBudgetCandidates returns the top last, but rank by cost so the test
// asserts on meaning, not array order. [LAW:behavior-not-structure]
const topCap = (candidates, diffSize = 100) =>
  candidates.reduce((a, b) => (estimatedCostUsd(b, diffSize) > estimatedCostUsd(a, diffSize) ? b : a)).roundCap;

// Difficulty VALUES built directly (difficultyCandidates consumes assessDifficulty's shape, not files),
// so each band is exercised by an exact, eyeball-checkable magnitude rather than a hand-tuned patch.
const diff = (churn, kinds) => ({ churn, kinds: { source: 0, tests: 0, docs: 0, ...kinds } });

describe('effortMagnitude — churn + spread surcharge, discounted when no source is touched', () => {
  test('a source change costs its churn plus a per-file surcharge', () => {
    // (churn 3 + 8*1 file) * sourceFactor 1 = 11
    assert.equal(effortMagnitude(diff(3, { source: 1 })), 11);
  });

  test('spread adds even when churn is tiny (a wide, thin change is not trivial)', () => {
    // (churn 5 + 8*10 files) * 1 = 85 — an order of magnitude above the same churn in one file (13)
    assert.equal(effortMagnitude(diff(5, { source: 10 })), 85);
    assert.ok(effortMagnitude(diff(5, { source: 10 })) > effortMagnitude(diff(5, { source: 1 })));
  });

  test('a tests-only / docs-only change is discounted (no source touched)', () => {
    // Same churn+spread, but source:0 scales the magnitude down by NONSOURCE_DISCOUNT.
    assert.ok(effortMagnitude(diff(40, { docs: 1 })) < effortMagnitude(diff(40, { source: 1 })));
    // (40 + 8) * 0.4 = 19.2
    assert.equal(Math.round(effortMagnitude(diff(40, { docs: 1 })) * 10) / 10, 19.2);
  });
});

describe('difficultyCandidates — propose an effort ladder that only ever LOWERS the ceiling', () => {
  const top5 = defaultEffortProfile({ roundCap: 5 });

  test('[ACCEPTANCE] a trivial diff proposes a strictly cheaper top candidate than a large diff', () => {
    const trivial = difficultyCandidates(diff(3, { source: 1 }), top5);   // magnitude 11 → band roundCap 1
    const large = difficultyCandidates(diff(400, { source: 6 }), top5);   // magnitude 448 → full ceiling 5
    // The ceiling chooseProfile would pick with no budget cap: trivial is cheaper than large.
    assert.ok(
      estimatedCostUsd({ ...top5, roundCap: topCap(trivial) }, 100)
      < estimatedCostUsd({ ...top5, roundCap: topCap(large) }, 100),
      'trivial diff must propose a cheaper ceiling than a large diff',
    );
    assert.equal(topCap(trivial), 1);
    assert.equal(topCap(large), 5);
  });

  test('[ACCEPTANCE] the user ceiling is NEVER exceeded — difficulty only caps DOWN', () => {
    const top2 = defaultEffortProfile({ roundCap: 2 });
    // A moderate diff whose band would propose roundCap 3, under a user cap of 2: the proposal is clamped
    // to the user's ceiling, never raised. [LAW:types-are-the-program] this slice cannot raise effort.
    const moderateUnderLowCap = difficultyCandidates(diff(150, { source: 1 }), top2); // band → 3, clamped to 2
    for (const c of moderateUnderLowCap) {
      assert.ok(effectiveRounds(c.roundCap) <= effectiveRounds(top2.roundCap), `candidate ${c.roundCap} exceeds ceiling 2`);
    }
    assert.equal(topCap(moderateUnderLowCap), 2);
    // A large diff under the low cap likewise tops out at the user's ceiling, not above.
    const largeUnderLowCap = difficultyCandidates(diff(400, { source: 6 }), top2);
    assert.equal(topCap(largeUnderLowCap), 2);
  });

  test('the bands are monotone: churn climbing lifts the proposed ceiling, never lowering it', () => {
    const caps = [diff(5, { source: 1 }), diff(50, { source: 1 }), diff(150, { source: 1 }), diff(500, { source: 1 })]
      .map((d) => topCap(difficultyCandidates(d, top5)));
    assert.deepEqual(caps, [1, 2, 3, 5]);
  });

  test('the 0="unlimited" ceiling is capped DOWN to a finite band for an easy change', () => {
    const topUnlimited = defaultEffortProfile({ roundCap: 0 });
    const trivial = difficultyCandidates(diff(3, { source: 1 }), topUnlimited); // band → 1, cheaper than unlimited
    assert.equal(topCap(trivial), 1);
    // No candidate is the unlimited sentinel — the easy change genuinely bounded the run.
    for (const c of trivial) assert.notEqual(c.roundCap, 0);
  });

  test('a substantial change under an unlimited ceiling keeps the unlimited ceiling (no lowering)', () => {
    const topUnlimited = defaultEffortProfile({ roundCap: 0 });
    const large = difficultyCandidates(diff(500, { source: 8 }), topUnlimited); // magnitude > every band → ceiling
    assert.ok(large.some((c) => c.roundCap === 0), 'the unlimited ceiling must remain a candidate for a hard change');
  });

  test('only roundCap moves — the profile\'s other axes are preserved', () => {
    for (const c of difficultyCandidates(diff(3, { source: 1 }), top5)) {
      assert.equal(c.scopeConcurrency, top5.scopeConcurrency);
    }
  });

  test('is reproducible — the same difficulty always yields a deep-equal ladder', () => {
    const d = diff(60, { source: 2, tests: 1 });
    assert.deepEqual(difficultyCandidates(d, top5), difficultyCandidates(d, top5));
  });
});

// [LAW:no-silent-failure] The off state (unset/false) is a value, not an error; a typo reds the run loud.
describe('parseDifficultyScaling', () => {
  test('unset / empty / false (any case) is the OFF value false', () => {
    for (const off of ['', '   ', undefined, 'false', 'FALSE', ' false ']) {
      assert.equal(parseDifficultyScaling(off), false, JSON.stringify(off));
    }
  });

  test('true (any case, trimmed) is on', () => {
    for (const on of ['true', 'TRUE', ' true ']) {
      assert.equal(parseDifficultyScaling(on), true, JSON.stringify(on));
    }
  });

  test('an unrecognized value throws — never a silent fall-back to off', () => {
    for (const bad of ['1', 'yes', 'on', 'no', 'abc']) {
      assert.throws(() => parseDifficultyScaling(bad), /Invalid DIFFICULTY_SCALING/, JSON.stringify(bad));
    }
  });
});

// The difficulty-only wiring seam (budget off): the difficulty proposal stands, unclamped by any spend.
describe('resolveDifficultyEffort — difficulty scaling with no budget cap', () => {
  const top5 = defaultEffortProfile({ roundCap: 5 });
  const smallDiff = [{ filename: 'a.js', patch: '@@ -1 +1 @@\n+x' }];        // churn 1
  const bigDiff = [{ filename: 'big.js', patch: '@@ -1 +1 @@\n' + '+x\n'.repeat(400) }];

  test('a trivial diff\'s proposal is returned unchanged (no budget to cap it below the ceiling)', () => {
    const candidates = difficultyCandidates(diff(3, { source: 1 }), top5); // ceiling roundCap 1
    const profile = resolveDifficultyEffort({ candidates, filteredFiles: smallDiff });
    assert.equal(profile.roundCap, 1);
  });

  test('a large diff keeps the full user ceiling — difficulty proposed it, no budget lowered it', () => {
    const candidates = difficultyCandidates(diff(400, { source: 6 }), top5); // full ladder up to 5
    const profile = resolveDifficultyEffort({ candidates, filteredFiles: bigDiff });
    assert.equal(profile.roundCap, 5);
  });
});
