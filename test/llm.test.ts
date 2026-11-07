import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatWithTools, generateJSON, LlmError } from "../src/llm/index.js";
import { mockFetch } from "./helpers.js";

const ROUTE = "POST /openai/v1/chat/completions";
const content = (text: string) => ({ json: { choices: [{ message: { content: text } }] } });
const schema = z.object({ amount: z.number().positive() });

describe("generateJSON", () => {
  it("returns validated output, using the model from env and JSON mode", async () => {
    const calls = mockFetch({ [ROUTE]: content('{"amount": 5}') });
    await expect(generateJSON(schema, "sys", "user")).resolves.toEqual({ amount: 5 });
    expect(calls[0]!.body.model).toBe("test-model");
    expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(calls[0]!.headers.Authorization).toBe("Bearer test-groq-key");
  });

  it("retries on a schema failure and feeds the error back", async () => {
    const replies = ['{"amount": -1}', '{"amount": 7}'];
    const calls = mockFetch({ [ROUTE]: () => content(replies.shift()!) });
    await expect(generateJSON(schema, "sys", "user")).resolves.toEqual({ amount: 7 });
    const lastMessage = calls[1]!.body.messages.at(-1);
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toMatch(/rejected/);
  });

  it("retries on invalid JSON", async () => {
    const replies = ["not json", '{"amount": 7}'];
    mockFetch({ [ROUTE]: () => content(replies.shift()!) });
    await expect(generateJSON(schema, "sys", "user")).resolves.toEqual({ amount: 7 });
  });

  it("gives up after two retries, three tries in all", async () => {
    const calls = mockFetch({ [ROUTE]: content('{"amount": -1}') });
    await expect(generateJSON(schema, "sys", "user")).rejects.toMatchObject({ kind: "bad_output" });
    expect(calls).toHaveLength(3);
  });

  it("retries when Groq rejects the model's own JSON", async () => {
    let first = true;
    mockFetch({
      [ROUTE]: () => {
        if (first) {
          first = false;
          return { status: 400, json: { error: { message: "bad", code: "json_validate_failed" } } };
        }
        return content('{"amount": 1}');
      },
    });
    await expect(generateJSON(schema, "sys", "user")).resolves.toEqual({ amount: 1 });
  });
});

describe("rate limits", () => {
  it("backs off and succeeds after a 429", async () => {
    let first = true;
    const calls = mockFetch({
      [ROUTE]: () => {
        if (first) {
          first = false;
          return { status: 429, json: {}, headers: { "retry-after": "1" } };
        }
        return content('{"amount": 2}');
      },
    });
    await expect(generateJSON(schema, "sys", "user")).resolves.toEqual({ amount: 2 });
    expect(calls).toHaveLength(2);
  });

  it("ends with a friendly message when limits persist", async () => {
    const calls = mockFetch({ [ROUTE]: { status: 429, json: {} } });
    const error = await generateJSON(schema, "sys", "user").catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.kind).toBe("rate_limited");
    expect(error.message).toMatch(/wait a minute/);
    expect(calls).toHaveLength(4);
  });
});

describe("configuration", () => {
  it("has an anthropic stub that says it's not configured", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    await expect(generateJSON(schema, "s", "u")).rejects.toThrow("not configured");
  });

  it("explains a missing model instead of using a built-in default", async () => {
    process.env.GROQ_MODEL = "";
    await expect(generateJSON(schema, "s", "u")).rejects.toThrow(/GROQ_MODEL/);
  });

  it("never puts the API key in an error", async () => {
    mockFetch({ [ROUTE]: { status: 500, json: { error: { message: "boom" } } } });
    const error = await generateJSON(schema, "s", "u").catch((e) => e);
    expect(error.message).not.toContain("test-groq-key");
  });
});

describe("chatWithTools", () => {
  it("sends function tools with JSON Schema and returns the calls", async () => {
    const calls = mockFetch({
      [ROUTE]: {
        json: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } },
                ],
              },
            },
          ],
        },
      },
    });
    const result = await chatWithTools({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", description: "d", parameters: z.object({ a: z.number() }) }],
    });
    expect(result.toolCalls).toEqual([{ id: "c1", name: "t", arguments: '{"a":1}' }]);
    expect(calls[0]!.body.tools[0].function.parameters.properties.a.type).toBe("number");
    expect(calls[0]!.body.messages[0]).toEqual({ role: "system", content: "s" });
  });
});
