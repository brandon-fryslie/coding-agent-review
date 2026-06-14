'use strict';

// Per-run token/cost reporting.
//
// [LAW:decomposition] Two cohesive concerns live here: the OpenAI price table (a
// representation that drifts from OpenAI's real prices and must be hand-maintained) and the
// pure renderer that formats an already-extracted Usage value into the review footer line.
// Extraction is engine-specific and lives in each adapter (engine/codex.js, engine/claude-code.js);
// this module only computes the Codex cost (from tokens x price) and formats the footer.
// [LAW:single-enforcer] Codex cost is computed in exactly one place: computeOpenAiCostUsd.

// [LAW:one-source-of-truth] The OpenAI price table. Dollars per ONE MILLION tokens, matching
// OpenAI's published per-1M figures so the numbers can be eyeballed against the pricing page.
// PRICE-SENSITIVE: these drift whenever OpenAI changes prices and have no machine source —
// they MUST be updated by hand. Last verified 2026-06-14 against https://openai.com/api/pricing/
// cachedInput is the discounted prompt-cache rate: across the GPT-5 family that is a 90% discount
// (cached = 10% of input), so each cachedInput is one-tenth of its input — keep that ratio when
// adding or updating a model unless OpenAI publishes a different cache discount for it.
const OPENAI_PRICES_PER_MILLION = {
  'gpt-5.5': { input: 5.00, cachedInput: 0.50, output: 30.00 },
  'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.50 },
};

// [LAW:effects-at-boundaries] Pure: tokens + model -> USD, no IO. Returns null (cost unknown)
// when the model has no price-table entry — never a fabricated zero, so a missing price surfaces
// as "unknown" rather than a confident-but-wrong $0.00. [LAW:no-silent-failure]
// input_tokens from the OpenAI/Codex usage event is the FULL prompt count (cached included);
// the cached subset is billed at the discounted cachedInput rate, the remainder at input rate.
// output_tokens already includes reasoning tokens, so they are priced once at the output rate.
function computeOpenAiCostUsd({ inputTokens, outputTokens, cachedInputTokens = 0 }, model) {
  const price = OPENAI_PRICES_PER_MILLION[model];
  if (!price) return null;
  const nonCachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const total =
    nonCachedInput * price.input +
    cachedInputTokens * price.cachedInput +
    outputTokens * price.output;
  return total / 1_000_000;
}

// Z.ai exposes an Anthropic-compatible endpoint, so Claude Code reports total_cost_usd using
// Anthropic's pricing — which is NOT what z.ai actually bills. Detect that endpoint so the
// rendered cost can be marked as an estimate. [FRAMING:representation] the cost is honest about
// being an Anthropic-priced estimate rather than silently claiming to be z.ai's real charge.
function isZaiEndpoint(config) {
  return Boolean(config.endpoint && config.endpoint.baseUrl && config.endpoint.baseUrl.includes('z.ai'));
}

function formatTokenCount(n) {
  return n.toLocaleString('en-US');
}

// [LAW:effects-at-boundaries] Pure: render the cost footer line from a Usage value, or '' when
// there is no usage to report. The "loud" warning for missing usage/price is an effect and
// belongs at the run boundary (src/run.js), not in this renderer. [LAW:dataflow-not-control-flow]
// usage === null and usage.costUsd === null are distinct values with distinct renderings, not
// branches that skip work: no usage -> no line; usage without a price -> tokens with cost "unknown".
function renderCostLine(usage, config) {
  if (!usage) return '';
  const tag = `${config.engine}/${config.model || '(default model)'}`;
  const tokens = `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out tokens`;
  if (usage.costUsd == null) {
    return `_Cost: unknown · ${tokens} · ${tag}_`;
  }
  const caveat = isZaiEndpoint(config) ? ' · est. (Anthropic pricing, not z.ai billing)' : '';
  return `_Cost: $${usage.costUsd.toFixed(4)} · ${tokens} · ${tag}${caveat}_`;
}

module.exports = {
  OPENAI_PRICES_PER_MILLION,
  computeOpenAiCostUsd,
  renderCostLine,
  formatTokenCount,
  isZaiEndpoint,
};
