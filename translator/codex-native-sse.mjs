// Equivalent JavaScript adaptation of CC Switch codex_responses_sse.rs.
// Upstream license: MIT, Copyright 2025 Jason Young.

export function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function messageCloseEvents(outputIndex, itemId, text) {
  const item = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return {
    item,
    events: [
      event("response.output_text.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text,
      }),
      event("response.content_part.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      }),
      outputItemDone(outputIndex, item),
    ],
  };
}

export function reasoningCloseEvents(outputIndex, itemId, text) {
  const item = {
    id: itemId,
    type: "reasoning",
    summary: [{ type: "summary_text", text }],
  };
  return {
    item,
    events: [
      event("response.reasoning_summary_text.done", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        text,
      }),
      event("response.reasoning_summary_part.done", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text },
      }),
      outputItemDone(outputIndex, item),
    ],
  };
}

export function responsesSseEvents(response, options = {}) {
  const frames = [];
  const chunkSize = Math.max(1, Number(options.chunkSize || 40));
  const inProgress = { ...response, status: "in_progress", output: [] };
  frames.push(event("response.created", { response: inProgress }));
  frames.push(event("response.in_progress", { response: inProgress }));

  for (const [outputIndex, item] of (response.output || []).entries()) {
    if (item.type === "message") {
      frames.push(outputItemAdded(outputIndex, {
        id: item.id,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      }));
      const content = Array.isArray(item.content) ? item.content : [];
      if (content.length === 1 && content[0]?.type === "output_text") {
        const text = String(content[0].text || "");
        frames.push(event("response.content_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }));
        for (const delta of chunks(text, chunkSize)) {
          frames.push(event("response.output_text.delta", {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            delta,
          }));
        }
        frames.push(...messageCloseEvents(outputIndex, item.id, text).events);
      } else {
        frames.push(outputItemDone(outputIndex, item));
      }
      continue;
    }

    if (item.type === "reasoning") {
      const text = String(item.summary?.[0]?.text || "");
      frames.push(outputItemAdded(outputIndex, {
        id: item.id,
        type: "reasoning",
        status: "in_progress",
        summary: [],
      }));
      frames.push(event("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }));
      for (const delta of chunks(text, chunkSize)) {
        frames.push(event("response.reasoning_summary_text.delta", {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: 0,
          delta,
        }));
      }
      frames.push(...reasoningCloseEvents(outputIndex, item.id, text).events);
      continue;
    }

    if (item.type === "custom_tool_call") {
      const input = String(item.input || "");
      frames.push(outputItemAdded(outputIndex, { ...item, status: "in_progress", input: "" }));
      for (const delta of chunks(input, chunkSize)) {
        frames.push(event("response.custom_tool_call_input.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta,
        }));
      }
      frames.push(event("response.custom_tool_call_input.done", {
        item_id: item.id,
        output_index: outputIndex,
        input,
      }));
      frames.push(outputItemDone(outputIndex, item));
      continue;
    }

    if (item.type === "function_call" || item.type === "tool_search_call") {
      const argumentsText = typeof item.arguments === "string"
        ? item.arguments
        : JSON.stringify(item.arguments || {});
      frames.push(outputItemAdded(outputIndex, { ...item, status: "in_progress", arguments: "" }));
      for (const delta of chunks(argumentsText, chunkSize)) {
        frames.push(event("response.function_call_arguments.delta", {
          item_id: item.id || `fc_${item.call_id}`,
          output_index: outputIndex,
          delta,
        }));
      }
      frames.push(event("response.function_call_arguments.done", {
        item_id: item.id || `fc_${item.call_id}`,
        output_index: outputIndex,
        arguments: argumentsText,
      }));
      frames.push(outputItemDone(outputIndex, item));
      continue;
    }

    frames.push(outputItemAdded(outputIndex, { ...item, status: "in_progress" }));
    frames.push(outputItemDone(outputIndex, item));
  }

  frames.push(response.status === "failed"
    ? event("response.failed", { response })
    : event("response.completed", { response }));
  return frames;
}

function event(type, fields) {
  return sseEvent(type, { type, ...fields });
}

function outputItemAdded(outputIndex, item) {
  return event("response.output_item.added", { output_index: outputIndex, item });
}

function outputItemDone(outputIndex, item) {
  return event("response.output_item.done", { output_index: outputIndex, item });
}

function chunks(text, size) {
  const output = [];
  for (let index = 0; index < text.length; index += size) output.push(text.slice(index, index + size));
  return output;
}
