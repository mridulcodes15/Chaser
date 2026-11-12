// The single gateway for every LLM call. Groq is used through its OpenAI-compatible
// API (https://console.groq.com/docs/openai). The model always comes from GROQ_MODEL.
import { z, type ZodType } from "zod";
import { getConfig, GROQ_BASE_URL } from "../config.js";

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_BACKOFF_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_JSON_RETRIES = 2;

/** Shown to users as is, so the messages stay friendly and contain no secrets. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limited" | "not_configured" | "bad_output" | "upstream",
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: RawToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ZodType;
}

export interface ChatResult {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  message: ChatMessage;
}

interface CompletionResponse {
  choices?: { message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
}

function requireGroq(): { apiKey: string; model: string } {
  const { LLM_PROVIDER, GROQ_API_KEY, GROQ_MODEL } = getConfig();
  if (LLM_PROVIDER === "anthropic") {
    throw new LlmError("The anthropic LLM provider is not configured.", "not_configured");
  }
  if (!GROQ_API_KEY || !GROQ_MODEL) {
    throw new LlmError(
      "The AI agent isn't set up yet: GROQ_API_KEY and GROQ_MODEL are both required.",
      "not_configured",
    );
  }
  return { apiKey: GROQ_API_KEY, model: GROQ_MODEL };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Groq says a retry could help, because the model produced invalid JSON or tool calls. */
class RetryableModelError extends Error {}

async function complete(body: Record<string, unknown>): Promise<CompletionResponse> {
  const { apiKey, model } = requireGroq();
  const { LLM_BACKOFF_BASE_MS } = getConfig();

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, ...body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new LlmError("The AI service couldn't be reached. Please try again.", "upstream");
    }

    if (res.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new LlmError(
          "The AI service is rate limited right now. Please wait a minute and try again.",
          "rate_limited",
        );
      }
      const retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000;
      const backoffMs = LLM_BACKOFF_BASE_MS * 2 ** attempt;
      // A base of 0 turns waiting off, which is how the tests run.
      if (LLM_BACKOFF_BASE_MS > 0) {
        await sleep(Math.min(Math.max(retryAfterMs, backoffMs), MAX_BACKOFF_MS));
      }
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      let error: { message?: string; code?: string } | undefined;
      try {
        error = (JSON.parse(text) as { error?: { message?: string; code?: string } }).error;
      } catch {
        // Not JSON. The status code is still reported below.
      }
      if (res.status === 400 && (error?.code === "json_validate_failed" || error?.code === "tool_use_failed")) {
        throw new RetryableModelError(error.message ?? error.code);
      }
      throw new LlmError(
        `The AI service returned an error (HTTP ${res.status})${error?.message ? `: ${error.message}` : "."}`,
        "upstream",
      );
    }
    return (await res.json()) as CompletionResponse;
  }
}

function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
}

/**
 * Gets a JSON object matching the schema. On invalid JSON or a schema failure, it
 * retries up to MAX_JSON_RETRIES times and feeds the error back to the model.
 */
export async function generateJSON<T>(schema: ZodType<T>, system: string, user: string): Promise<T> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${system}\n\nRespond with one JSON object only, matching this JSON Schema:\n${JSON.stringify(jsonSchemaOf(schema))}`,
    },
    { role: "user", content: user },
  ];

  let lastProblem = "";
  for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
    let content: string | null | undefined;
    try {
      const response = await complete({
        messages,
        temperature: 0.2,
        max_completion_tokens: 2000,
        response_format: { type: "json_object" },
      });
      content = response.choices?.[0]?.message?.content;
    } catch (error) {
      if (!(error instanceof RetryableModelError)) throw error;
      lastProblem = error.message;
      messages.push({ role: "user", content: `Your last reply failed: ${lastProblem}. Reply again with valid JSON.` });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content ?? "");
    } catch {
      lastProblem = "the reply was not valid JSON";
      messages.push(
        { role: "assistant", content: content ?? "" },
        { role: "user", content: `Your last reply was rejected: ${lastProblem}. Reply again with one JSON object.` },
      );
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    lastProblem = z.prettifyError(result.error);
    messages.push(
      { role: "assistant", content: content ?? "" },
      { role: "user", content: `Your last reply was rejected:\n${lastProblem}\nFix these problems and reply with one JSON object.` },
    );
  }
  throw new LlmError(
    `The AI service didn't produce a valid result after ${MAX_JSON_RETRIES + 1} tries. Last problem: ${lastProblem}`,
    "bad_output",
  );
}

/** One chat turn with tools. The caller runs the tools and validates their arguments. */
export async function chatWithTools(input: {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
}): Promise<ChatResult> {
  const body = {
    messages: [{ role: "system", content: input.system }, ...input.messages],
    temperature: 0.2,
    max_completion_tokens: 2000,
    tool_choice: "auto",
    tools: input.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonSchemaOf(tool.parameters),
      },
    })),
  };

  let response: CompletionResponse;
  try {
    response = await complete(body);
  } catch (error) {
    if (!(error instanceof RetryableModelError)) throw error;
    try {
      response = await complete(body);
    } catch (retryError) {
      if (retryError instanceof RetryableModelError) {
        throw new LlmError("The AI service couldn't produce a valid tool call. Please try again.", "bad_output");
      }
      throw retryError;
    }
  }

  const message = response.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  return {
    content: message?.content ?? null,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    message: {
      role: "assistant",
      content: message?.content ?? null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  };
}
