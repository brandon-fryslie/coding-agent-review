'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { defaultEffortProfile, resolveReasoningTier, TIER_RANK } = require('../src/effort');
const registry = require('../src/engine/registry');

describe('defaultEffortProfile', () => {
  test('reproduces the pre-profile scope concurrency (4)', () => {
    assert.deepEqual(defaultEffortProfile(), { scopeConcurrency: 4 });
  });

  test('returns a fresh object each call (no shared mutable default)', () => {
    const a = defaultEffortProfile();
    a.scopeConcurrency = 99;
    assert.equal(defaultEffortProfile().scopeConcurrency, 4);
  });
});

describe('resolveReasoningTier — value-driven resolution', () => {
  const ANY = ['low', 'medium', 'high', 'max'];

  test('null/undefined tier resolves to null (leave the engine default)', () => {
    assert.equal(resolveReasoningTier(null, ANY), null);
    assert.equal(resolveReasoningTier(undefined, ANY), null);
  });

  test('an empty engine range resolves ANY tier to null (axis unsupported)', () => {
    assert.equal(resolveReasoningTier('high', []), null);
    assert.equal(resolveReasoningTier('minimal', []), null);
    assert.equal(resolveReasoningTier(null, []), null);
  });

  test('a tier the engine supports passes through unchanged (identity — the case today)', () => {
    for (const t of ANY) assert.equal(resolveReasoningTier(t, ANY), t);
  });

  test('an unknown tier string throws, naming the known tiers (no silent clamp)', () => {
    assert.throws(() => resolveReasoningTier('turbo', ANY), /Unknown reasoning tier/);
    assert.throws(() => resolveReasoningTier('turbo', ANY), /minimal, low, medium, high, xhigh, max/);
  });

  test('a supported-elsewhere tier clamps to the nearest rung the engine offers', () => {
    // 'minimal' is below claude-code's floor ('low') → clamp up to 'low'.
    assert.equal(resolveReasoningTier('minimal', ANY), 'low');
    // 'xhigh' is codex's ceiling; claude-code's ceiling 'max' shares its rank → top→top.
    assert.equal(resolveReasoningTier('xhigh', ANY), 'max');
  });

  test('on a distance tie, the LOWER (cheaper) rung wins', () => {
    // Range with a gap: 'medium' (rank 2) is equidistant from 'low' (1) and 'high' (3).
    assert.equal(resolveReasoningTier('medium', ['low', 'high']), 'low');
  });

  test("codex's ceiling 'xhigh' clamps DOWN to claude-code's true rungs, never inventing one", () => {
    assert.equal(resolveReasoningTier('max', ['minimal', 'low', 'medium', 'high', 'xhigh']), 'xhigh');
  });
});

// The acceptance criterion: assert reasoning-tier clamping against each ADAPTER's declared range,
// read from the registry (the single source of truth), so the test tracks the real capabilities.
describe('resolveReasoningTier — against each adapter’s declared reasoning-effort range', () => {
  const ENGINES = ['claude-code', 'codex', 'opencode'];
  const ALL_TIERS = Object.keys(TIER_RANK);

  for (const name of ENGINES) {
    const range = registry.get(name).capabilities.reasoningEfforts;

    test(`${name}: every abstract tier resolves to a value the engine actually supports (or null)`, () => {
      for (const tier of ALL_TIERS) {
        const resolved = resolveReasoningTier(tier, range);
        if (range.length === 0) {
          assert.equal(resolved, null, `${name} declares no range, so ${tier} must resolve to null`);
        } else {
          assert.ok(range.includes(resolved), `${name}: ${tier} resolved to ${resolved}, not in ${range.join(',')}`);
        }
      }
    });

    test(`${name}: null always resolves to null (engine default preserved)`, () => {
      assert.equal(resolveReasoningTier(null, range), null);
    });
  }

  test('opencode (empty range) ignores the axis for every tier', () => {
    const range = registry.get('opencode').capabilities.reasoningEfforts;
    assert.deepEqual(range, []);
    for (const tier of ALL_TIERS) assert.equal(resolveReasoningTier(tier, range), null);
  });

  test('claude-code clamps codex-only tiers into its own range', () => {
    const range = registry.get('claude-code').capabilities.reasoningEfforts;
    assert.equal(resolveReasoningTier('minimal', range), 'low');   // below floor → floor
    assert.equal(resolveReasoningTier('xhigh', range), 'max');     // codex ceiling → claude ceiling
  });

  test('codex clamps claude-only tiers into its own range', () => {
    const range = registry.get('codex').capabilities.reasoningEfforts;
    assert.equal(resolveReasoningTier('max', range), 'xhigh');     // claude ceiling → codex ceiling
  });
});
