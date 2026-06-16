'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runEngine, appendBounded, MAX_RETAINED_OUTPUT } = require('../src/engine/run.js');

// appendBounded is the single retention policy shared by stdout and stderr: append, then keep
// only the trailing MAX_RETAINED_OUTPUT bytes. These assert the contract directly (fast, pure).
describe('appendBounded', () => {
  test('under the cap, retains everything in order', () => {
    assert.equal(appendBounded('foo', 'bar'), 'foobar');
    assert.equal(appendBounded('', ''), '');
  });

  test('over the cap, retains exactly the trailing window', () => {
    const out = appendBounded('', 'a'.repeat(MAX_RETAINED_OUTPUT + 10));
    assert.equal(out.length, MAX_RETAINED_OUTPUT);
  });

  test('preserves the NEWEST bytes (tail) and discards the OLDEST (head)', () => {
    // The terminal turn.completed/turn.failed events are emitted LAST, so the tail is what the
    // caller needs; an old head fragment is the safe thing to drop.
    const out = appendBounded('OLDEST_MARKER', 'b'.repeat(MAX_RETAINED_OUTPUT));
    assert.equal(out.length, MAX_RETAINED_OUTPUT);
    assert.ok(!out.includes('OLDEST_MARKER'));
    assert.ok(out.endsWith('b'));
  });
});

// A fake engine whose spawned process emits MORE than the retained cap of stdout, then optionally
// a terminal success line. runEngine reads only stdout (findings flow out-of-band via the
// collector elsewhere), so the collector argument is irrelevant here.
function makeAdapter({ emitTerminal }) {
  const overflow = MAX_RETAINED_OUTPUT + 256 * 1024;
  const script =
    `const big='x'.repeat(65536);` +
    `let w=0; while(w<${overflow}){process.stdout.write(big); w+=big.length;}` +
    (emitTerminal ? `process.stdout.write('\\n'+JSON.stringify({type:'turn.completed'})+'\\n');` : ``);
  return {
    name: 'fake',
    timeoutMs: 30_000,
    buildCommand: () => ({
      command: process.execPath,
      args: ['-e', script],
      env: { PATH: process.env.PATH },
    }),
    // Mirror the real adapters: completion is judged by the presence of the terminal event.
    assertSucceeded: stdout => {
      const completed = stdout.split('\n').some(line => {
        try { return JSON.parse(line).type === 'turn.completed'; } catch { return false; }
      });
      if (!completed) throw new Error('fake review did not complete: turn.completed not emitted.');
    },
    classifyError: err => err,
  };
}

describe('runEngine with an oversized engine stream', () => {
  // The bug this guards: a 1MB stdout ceiling killed every substantial, law-comment-dense review
  // mid-flight, so the reviewer was effectively non-functional on real PRs (slopspot-tooling-yjz).
  test('a stream larger than the retained cap that ends in a terminal success COMPLETES (not killed on size)', async () => {
    const stdout = await runEngine(makeAdapter({ emitTerminal: true }), {}, 'prompt', '/tmp', {}, process.cwd());
    assert.ok(stdout.length <= MAX_RETAINED_OUTPUT, `retained ${stdout.length} exceeds cap ${MAX_RETAINED_OUTPUT}`);
    assert.ok(stdout.includes('turn.completed'), 'the terminal event the caller needs survives in the tail');
  });

  test('an oversized stream with NO terminal success still FAILS LOUD (never laundered into a clean pass)', async () => {
    await assert.rejects(
      runEngine(makeAdapter({ emitTerminal: false }), {}, 'prompt', '/tmp', {}, process.cwd()),
      /did not complete/,
    );
  });
});
