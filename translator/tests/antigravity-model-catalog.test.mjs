import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAvailableAgentModels,
  buildAntigravityModelCatalog,
  validateAvailableAgentModels,
} from "../antigravity-model-catalog.mjs";

test("extractAvailableAgentModels extracts and sorts models correctly", () => {
  const payload = {
    response: {
      models: {
        "model-a": { model: "INTERNAL_A", displayName: "Model A" },
        "model-b": { model: "INTERNAL_B", displayName: "Model B" },
        "model-c": { model: "INTERNAL_C", displayName: "Model C" }
      },
      agentModelSorts: [
        {
          groups: [
            {
              modelIds: ["model-c", "model-a"]
            }
          ]
        }
      ]
    }
  };

  const extracted = extractAvailableAgentModels(payload);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].id, "model-c");
  assert.equal(extracted[1].id, "model-a");
});

test("extractAvailableAgentModels handles empty/malformed payload robustly", () => {
  assert.deepEqual(extractAvailableAgentModels(null), []);
  assert.deepEqual(extractAvailableAgentModels({}), []);
  assert.deepEqual(extractAvailableAgentModels({ response: {} }), []);
  assert.deepEqual(extractAvailableAgentModels({ response: { models: {} } }), []);
});

test("extractAvailableAgentModels falls back to model keys only when no agent sort exists", () => {
  const payload = {
    response: {
      models: {
        "model-a": { model: "INTERNAL_A", displayName: "Model A" },
        "model-b": { model: "INTERNAL_B", displayName: "Model B" },
      },
    },
  };

  assert.deepEqual(
    extractAvailableAgentModels(payload).map((model) => model.id),
    ["model-a", "model-b"],
  );
});

test("buildAntigravityModelCatalog maps model fields correctly", () => {
  const baseCatalog = {
    models: [
      {
        base_instructions: "System prompt",
        shell_type: "shell_command"
      }
    ]
  };

  const availableModels = [
    {
      id: "gemini-3.5-flash-low",
      model: "MODEL_FLASH_LOW",
      displayName: "Gemini 3.5 Flash (Medium)",
      maxTokens: 1048576,
      supportsImages: true,
      supportsThinking: true,
      thinkingBudget: 4000,
      minThinkingBudget: 32
    },
    {
      id: "gpt-oss-120b-medium",
      model: "MODEL_GPT_OSS",
      displayName: "GPT-OSS 120B (Medium)",
      maxTokens: 131072
    }
  ];

  const catalog = buildAntigravityModelCatalog(baseCatalog, availableModels);
  assert.equal(catalog.models.length, 2);

  // First model. The ID is authoritative when Antigravity's displayName
  // carries a stale or mismatched reasoning suffix.
  const m1 = catalog.models[0];
  assert.equal(m1.slug, "gemini-3.5-flash-low");
  assert.equal(m1.display_name, "Gemini 3.5 Flash (Low)");
  assert.equal(m1.context_window, 1048576);
  assert.equal(m1.max_context_window, 1048576);
  assert.deepEqual(m1.input_modalities, ["text", "image"]);
  assert.equal(m1.default_reasoning_level, "low");
  assert.deepEqual(m1.supported_reasoning_levels, [
    { effort: "low", description: "Antigravity native thinking budget 4000 (minimum 32)" }
  ]);
  assert.equal(m1.antigravity_supports_thinking, true);
  assert.equal(m1.antigravity_thinking_budget, 4000);
  assert.equal(m1.antigravity_min_thinking_budget, 32);
  assert.equal(m1.base_instructions, "System prompt");
  assert.equal(m1.shell_type, "shell_command");
  assert.equal(m1.priority, 0);
  assert.equal(m1.visibility, "list");
  assert.equal(m1.supported_in_api, true);
  assert.equal(m1.upgrade, null);
  assert.equal(m1.availability_nux, null);

  // Second model (No image support)
  const m2 = catalog.models[1];
  assert.equal(m2.slug, "gpt-oss-120b-medium");
  assert.equal(m2.display_name, "GPT-OSS 120B (Medium)");
  assert.equal(m2.context_window, 131072);
  assert.equal(m2.max_context_window, 131072);
  assert.deepEqual(m2.input_modalities, ["text"]);
  assert.equal(m2.priority, 1);
  assert.equal(m2.visibility, "list");
});

test("buildAntigravityModelCatalog maps reasoning levels correctly based on display name and ID", () => {
  const baseCatalog = { models: [{}] };
  
  const testCases = [
    { name: "Gemini (Low)", id: "any-id", expected: "low" },
    { name: "Gemini (Extra-Low)", id: "any-id", expected: "low" },
    { name: "Gemini (Medium)", id: "any-id", expected: "medium" },
    { name: "Gemini (High)", id: "any-id", expected: "high" },
    { name: "Gemini (Thinking)", id: "any-id", expected: "xhigh" },
    // Fallback on ID
    { name: "Gemini 3.5 Flash", id: "gemini-3.5-flash-extra-low", expected: "low" },
    { name: "Gemini 3.1 Pro", id: "gemini-3.1-pro-low", expected: "low" },
    { name: "Gemini 3.5 Flash", id: "gemini-3.5-flash-medium", expected: "medium" },
    { name: "Gemini 3.5 Flash", id: "gemini-3-flash-high", expected: "high" },
    { name: "Claude Opus", id: "claude-opus-4-6-thinking", expected: "xhigh" },
    // Fallback default
    { name: "Unknown Model", id: "unknown-id", expected: "medium" }
  ];

  for (const tc of testCases) {
    const catalog = buildAntigravityModelCatalog(baseCatalog, [
      { id: tc.id, model: `INTERNAL_${tc.expected}`, displayName: tc.name }
    ]);
    assert.equal(catalog.models[0].default_reasoning_level, tc.expected);
    assert.equal(catalog.models[0].supported_reasoning_levels[0].effort, tc.expected);
  }
});

test("buildAntigravityModelCatalog keeps model numbers and corrects mismatched reasoning suffixes", () => {
  const catalog = buildAntigravityModelCatalog({ models: [{}] }, [
    { id: "gemini-3.5-flash-low", model: "MODEL_1", displayName: "Gemini 3.5 Flash (Medium)" },
    { id: "gemini-3.5-flash-extra-low", model: "MODEL_2", displayName: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-pro-high", model: "MODEL_3", displayName: "Gemini 3.1 Pro (Low)" },
    { id: "claude-opus-4-6-thinking", model: "MODEL_4", displayName: "Claude Opus 4.6" },
  ]);

  assert.deepEqual(
    catalog.models.map((model) => [
      model.slug,
      model.display_name,
      model.default_reasoning_level,
    ]),
    [
      ["gemini-3.5-flash-low", "Gemini 3.5 Flash (Low)", "low"],
      ["gemini-3.5-flash-extra-low", "Gemini 3.5 Flash (Extra Low)", "low"],
      ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)", "high"],
      ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", "xhigh"],
    ],
  );
});

test("buildAntigravityModelCatalog handles empty/missing input robustly", () => {
  const catalog1 = buildAntigravityModelCatalog(null, null);
  assert.deepEqual(catalog1.models, []);

  const catalog2 = buildAntigravityModelCatalog({ models: [] }, []);
  assert.deepEqual(catalog2.models, []);
});

test("model catalog rejects menu entries that cannot be routed", () => {
  assert.throws(
    () => validateAvailableAgentModels([{ id: "visible-but-unroutable", displayName: "Visible" }]),
    /does not expose an internal model enum/,
  );
  assert.throws(
    () => buildAntigravityModelCatalog({ models: [{}] }, [{ id: "visible-but-unroutable" }]),
    /does not expose an internal model enum/,
  );
});
