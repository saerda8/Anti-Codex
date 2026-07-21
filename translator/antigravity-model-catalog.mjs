/**
 * Extracts currently available models from the Antigravity GetAvailableModels response payload.
 * It respects the order of models defined in the response's agentModelSorts list.
 *
 * @param {Object} payload - The raw response payload from GetAvailableModels.
 * @returns {Array<Object>} Array of model objects with an added `id` property, in sorted order.
 */
export function extractAvailableAgentModels(payload) {
  if (!payload || !payload.response) {
    return [];
  }

  const response = payload.response;
  const models = response.models || {};
  const sorts = response.agentModelSorts || response.agent_model_sorts || [];

  const modelIds = [];
  for (const sort of sorts) {
    const groups = sort.groups || [];
    for (const group of groups) {
      const ids = group.modelIds || group.model_ids || [];
      for (const id of ids) {
        if (id && !modelIds.includes(id)) {
          modelIds.push(id);
        }
      }
    }
  }

  if (modelIds.length === 0) {
    modelIds.push(...Object.keys(models));
  }

  const result = [];
  for (const id of modelIds) {
    const model = models[id];
    if (model) {
      result.push({
        id,
        ...model
      });
    }
  }

  return result;
}

/**
 * Converts a list of available models into a Codex model catalog format,
 * merging with baseline catalog fields (like instructions and messages) from baseCatalog.
 *
 * @param {Object} baseCatalog - The baseline model catalog configuration.
 * @param {Array<Object>} availableModels - The array of extracted available models.
 * @returns {Object} A complete new catalog object with translated models.
 */
export function buildAntigravityModelCatalog(baseCatalog, availableModels) {
  const base = baseCatalog || {};
  const baseModels = base.models || [];
  const templateModel = baseModels[0] || {};
  validateAvailableAgentModels(availableModels || []);

  const translatedModels = (availableModels || []).map((model, index) => {
    const modelId = model.id || `unknown-model-${index}`;
    const displayName = normalizeAntigravityDisplayName(modelId, model.displayName || modelId);
    const effort = antigravityReasoningEffortFor(modelId, displayName);
    const supportsThinking = model.supportsThinking === true || model.supports_thinking === true;
    const thinkingBudget = finiteNumberOrNull(model.thinkingBudget ?? model.thinking_budget);
    const minThinkingBudget = finiteNumberOrNull(model.minThinkingBudget ?? model.min_thinking_budget);

    const reasoningDescriptions = {
      low: "Antigravity low reasoning",
      medium: "Antigravity medium reasoning",
      high: "Antigravity high reasoning",
      xhigh: "Antigravity max reasoning"
    };

    const supportedLevels = [{
      effort: effort,
      description: nativeThinkingDescription({
        effort,
        supportsThinking,
        thinkingBudget,
        minThinkingBudget,
        fallback: reasoningDescriptions[effort] || `Antigravity ${effort} reasoning`,
      }),
    }];

    // Determine input modalities based on supportsImages
    const input_modalities = model.supportsImages ? ["text", "image"] : ["text"];

    // Context limit mapping with robust fallback to template or default
    const contextLimit = typeof model.maxTokens === "number" && model.maxTokens > 0
      ? model.maxTokens
      : (templateModel.context_window || 16384);

    // Build the translated model catalog entry
    return {
      ...templateModel,
      slug: modelId,
      display_name: displayName,
      description: model.description || `antigravity-${modelId}`,
      visibility: "list",
      supported_in_api: true,
      upgrade: null,
      availability_nux: null,
      default_reasoning_level: effort,
      supported_reasoning_levels: supportedLevels,
      context_window: contextLimit,
      max_context_window: contextLimit,
      input_modalities,
      antigravity_supports_thinking: supportsThinking,
      ...(thinkingBudget !== null ? { antigravity_thinking_budget: thinkingBudget } : {}),
      ...(minThinkingBudget !== null ? { antigravity_min_thinking_budget: minThinkingBudget } : {}),
      priority: index
    };
  });

  return {
    ...base,
    models: translatedModels
  };
}

function nativeThinkingDescription({ supportsThinking, thinkingBudget, minThinkingBudget, fallback }) {
  if (!supportsThinking || thinkingBudget === null) return fallback;
  const budget = thinkingBudget < 0 ? "dynamic" : String(thinkingBudget);
  const minimum = minThinkingBudget !== null && minThinkingBudget >= 0
    ? ` (minimum ${minThinkingBudget})`
    : "";
  return `Antigravity native thinking budget ${budget}${minimum}`;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validateAvailableAgentModels(availableModels) {
  for (const [index, model] of (availableModels || []).entries()) {
    const id = String(model?.id ?? "").trim();
    const internalModel = String(model?.model ?? "").trim();
    if (!id) {
      throw new Error(`Antigravity model entry ${index} is missing its public model ID.`);
    }
    if (!internalModel) {
      throw new Error(`Antigravity model ${id} does not expose an internal model enum.`);
    }
  }
  return true;
}

export function antigravityReasoningEffortFor(modelId, displayName) {
  return reasoningHintFromText(modelId)?.effort
    ?? reasoningHintFromText(displayName)?.effort
    ?? "medium";
}

export function normalizeAntigravityDisplayName(modelId, displayName) {
  const rawName = String(displayName || modelId || "").trim() || "Antigravity";
  const hint = reasoningHintFromText(modelId);
  if (!hint) return rawName;

  const wantedSuffix = `(${hint.label})`;
  if (/\([^)]+\)\s*$/.test(rawName)) {
    return rawName.replace(/\([^)]+\)\s*$/, wantedSuffix);
  }
  return `${rawName} ${wantedSuffix}`;
}

function reasoningHintFromText(value) {
  const text = String(value ?? "").toLowerCase();
  if (!text) return null;
  if (/(?:extra[-_\s]?low)/.test(text)) return { effort: "low", label: "Extra Low" };
  if (/(?:thinking|xhigh|max)/.test(text)) return { effort: "xhigh", label: "Thinking" };
  if (/(?:\blow\b|-low\b|_low\b)/.test(text)) return { effort: "low", label: "Low" };
  if (/(?:\bmedium\b|-medium\b|_medium\b)/.test(text)) return { effort: "medium", label: "Medium" };
  if (/(?:\bhigh\b|-high\b|_high\b)/.test(text)) return { effort: "high", label: "High" };
  return null;
}
