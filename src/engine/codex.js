'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TransientError } = require('../failover');

const CODEX_PACKAGE = '@openai/codex@latest';
const CODEX_TIMEOUT_MS = 3_000_000;

// Internal provider name used in config.toml. Codex requires an explicit 'name' field
// inside each [model_providers.<key>] section — without it, config load fails with
// "provider name must not be empty". Must be alphanumeric, no underscores or hyphens.
// 'api' is generic and avoids collisions with codex built-in names (e.g. 'openai').
const INTERNAL_PROVIDER = 'api';

// [LAW:one-source-of-truth] Declared once; both the prompt (via toolNames) and the
// config.toml (N/A for codex) reference the same strings. Codex surfaces MCP tools with
// the same naming convention as Claude Code (verified via live handshake, 2026-06-12).
const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
};

// [LAW:effects-at-boundaries] Pure: produces TOML text from values, touches no filesystem.
// Codex requires: explicit `name` field in each model_provider entry; model formatted as
// "<provider>/<model>"; REVIEW_COLLECTOR_RECORDS in mcp_servers env sub-table.
// --dangerously-bypass-approvals-and-sandbox is required in the spawn invocation because
// approval_policy = "never" only covers shell commands; MCP tool calls have a separate
// approval gate that requires this flag in non-interactive (--json) mode.
function buildConfigToml(config, collectorSpawn) {
  const { command, args, env: collectorEnv } = collectorSpawn;

  // TOML string escaping: escape backslashes then double-quotes.
  const q = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const arr = vs => `[${vs.map(q).join(', ')}]`;

  const lines = [
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    `model = ${q(INTERNAL_PROVIDER + '/' + config.model)}`,
  ];
  if (config.reasoning) {
    lines.push(`model_reasoning_effort = ${q(config.reasoning)}`);
  }

  lines.push(
    '',
    `[model_providers.${INTERNAL_PROVIDER}]`,
    `name = ${q(INTERNAL_PROVIDER)}`,
    `base_url = ${q(config.endpoint.baseUrl)}`,
    `env_key = ${q(config.endpoint.apiKeyEnv)}`,
    '',
    '[mcp_servers.review_collector]',
    `command = ${q(command)}`,
    `args = ${arr(args)}`,
    '',
    '[mcp_servers.review_collector.env]',
    `REVIEW_COLLECTOR_RECORDS = ${q(collectorEnv.REVIEW_COLLECTOR_RECORDS)}`,
  );

  return lines.join('\n') + '\n';
}

// [LAW:effects-at-boundaries] The only effect in this adapter: writing files to a temp home.
// Returns the temp dir path, which becomes CODEX_HOME for the spawned process.
function materializeHome({ config, instructionsPath, collector }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-codex-home-'));

  // [LAW:single-enforcer] Instructions are copied from the one shared source.
  fs.copyFileSync(instructionsPath, path.join(home, 'AGENTS.md'));

  // Read the collector's already-computed spawn spec rather than recomputing it.
  // [LAW:one-source-of-truth] createReviewCollector owns these paths and the node binary ref.
  const mcpCfg = JSON.parse(fs.readFileSync(collector.mcpConfigPath, 'utf8'));
  const collectorSpawn = mcpCfg.mcpServers.review_collector;

  fs.writeFileSync(path.join(home, 'config.toml'), buildConfigToml(config, collectorSpawn), 'utf8');
  return home;
}

// [LAW:effects-at-boundaries] Pure: returns a full spawn spec from the validated ReviewConfig.
// [LAW:single-enforcer] Auth translation happens exactly once: the apiKeyEnv env var is
// injected here, referenced by model_providers in config.toml.
// --dangerously-bypass-approvals-and-sandbox is intentional for CI: GitHub Actions is an
// externally sandboxed environment (per Codex docs: "Intended solely for running in
// environments that are externally sandboxed"). MCP tool calls do not auto-execute in
// --json mode without this flag regardless of approval_policy in config.toml.
function buildCommand({ config, home }) {
  return {
    command: 'npx',
    args: ['-y', CODEX_PACKAGE, 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      [config.endpoint.apiKeyEnv]: config.endpoint.apiKey,
    },
  };
}

// Parse the JSONL event stream from codex exec --json. Success = turn.completed present
// without a prior turn.failed. Non-JSON lines (stderr noise) are skipped.
// [LAW:no-silent-failure] A turn.failed event always surfaces its message.
function assertSucceeded(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'turn.failed') {
      throw new Error(`Codex review failed: ${event.error?.message ?? 'unknown error'}`);
    }
  }
}

// [LAW:single-enforcer] OpenAI Responses API transient signals classified once, here.
// 429 + rate_limit are rate-limiting; insufficient_quota is a billing limit (also transient
// in the sense that exhaustion clears with time or a new quota window). [LAW:one-source-of-truth]
function classifyError(err, text) {
  if (/\b429\b|rate.?limit/i.test(text)) return new TransientError(`rate-limited: ${err.message}`);
  if (/insufficient.quota|quota.exceeded/i.test(text)) return new TransientError(`quota exceeded: ${err.message}`);
  return err;
}

// [LAW:one-type-per-behavior] One adapter object per engine CLI.
const codexAdapter = {
  name: 'codex',
  timeoutMs: CODEX_TIMEOUT_MS,
  capabilities: {
    // [LAW:types-are-the-program] Capability declarations are the single source of truth
    // for config validation in src/config.js. Illegal combos (e.g. anthropic-messages
    // endpoint with codex) are rejected at load time, never discovered at spawn time.
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    endpointKinds: ['openai-responses'],
    findingsChannels: ['mcp-collector'],
  },
  toolNames: TOOL_NAMES,
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
};

module.exports = { codexAdapter, buildConfigToml };
