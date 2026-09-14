import { createOpenAI } from "@ai-sdk/openai";
import Anthropic from "@anthropic-ai/sdk";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import OpenAI from "openai";
import { expect, it } from "vitest";
import {
  aiSDKModel,
  createModelGateway,
  nativeModel,
  openAICompatibleModel,
} from "../../packages/agent-api/src/models.js";
import { serveFetch } from "./http.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
it.each(["responses", "anthropic", "chat-completions"] as const)(
  "%s reaches an instantiated OpenAI AI SDK model through the gateway",
  async (protocol) => {
    const prompts: string[] = [];
    const upstream = createModelGateway(() => ({
      "provider-model": aiSDKModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt, tools }) => {
            prompts.push(JSON.stringify(prompt));
            const call = !JSON.stringify(prompt).includes("lookup-result");
            expect(tools?.some((tool) => tool.type === "function" && tool.name === "lookup")).toBe(
              true,
            );
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  ...(call
                    ? [
                        {
                          type: "tool-call" as const,
                          toolCallId: "call_lookup",
                          toolName: "lookup",
                          input: '{"query":"value"}',
                        },
                      ]
                    : [
                        { type: "text-start" as const, id: "msg_answer" },
                        {
                          type: "text-delta" as const,
                          id: "msg_answer",
                          delta: "Model instance reached.",
                        },
                        { type: "text-end" as const, id: "msg_answer" },
                      ]),
                  {
                    type: "finish",
                    finishReason: { unified: call ? "tool-calls" : "stop", raw: undefined },
                    usage,
                  },
                ],
              }),
            };
          },
        }),
      ),
    }));
    const provider = await serveFetch((request) => upstream.fetch(request, {}));
    const openai = createOpenAI({ apiKey: "fixture", baseURL: `${provider.url}/v1` });
    const gateway = createModelGateway(() => ({
      primary: aiSDKModel(openai("provider-model"), {
        providerOptions: { openai: { store: false } },
      }),
    }));
    const server = await serveFetch((request) => gateway.fetch(request, {}));
    const parameters = {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };
    const client = new OpenAI({ apiKey: "fixture", baseURL: `${server.url}/v1`, maxRetries: 0 });
    try {
      if (protocol === "responses") {
        const tools = [
          {
            type: "function" as const,
            name: "lookup",
            description: "Look up a value",
            parameters,
            strict: true,
          },
        ];
        const first = await client.responses.create({
          model: "primary",
          input: "Look up the value",
          tools,
          store: false,
        });
        const call = first.output.find((item) => item.type === "function_call");
        if (!call) throw new Error("Missing function call");
        const second = await client.responses.create({
          model: "primary",
          input: [
            { role: "user", content: "Look up the value" },
            call,
            { type: "function_call_output", call_id: call.call_id, output: "lookup-result" },
          ],
          tools,
          stream: true,
          store: false,
        });
        let answer = "";
        for await (const event of second)
          if (event.type === "response.output_text.delta") answer += event.delta;
        expect(answer).toBe("Model instance reached.");
      } else if (protocol === "anthropic") {
        const anthropic = new Anthropic({ apiKey: "fixture", baseURL: server.url, maxRetries: 0 });
        const tools = [
          { name: "lookup", description: "Look up a value", input_schema: parameters },
        ];
        const first = await anthropic.messages.create({
          model: "primary",
          max_tokens: 100,
          messages: [{ role: "user", content: "Look up the value" }],
          tools,
        });
        const call = first.content.find((item) => item.type === "tool_use");
        if (!call) throw new Error("Missing function call");
        const second = await anthropic.messages.create({
          model: "primary",
          max_tokens: 100,
          messages: [
            { role: "user", content: "Look up the value" },
            { role: "assistant", content: first.content },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: call.id, content: "lookup-result" }],
            },
          ],
          tools,
          stream: true,
        });
        let answer = "";
        for await (const event of second)
          if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            answer += event.delta.text;
        expect(answer).toBe("Model instance reached.");
      } else {
        const tools = [
          {
            type: "function" as const,
            function: { name: "lookup", description: "Look up a value", parameters },
          },
        ];
        const first = await client.chat.completions.create({
          model: "primary",
          messages: [{ role: "user", content: "Look up the value" }],
          tools,
        });
        const message = first.choices[0]?.message;
        const call = message?.tool_calls?.[0];
        if (!message || !call) throw new Error("Missing function call");
        const second = await client.chat.completions.create({
          model: "primary",
          messages: [
            { role: "user", content: "Look up the value" },
            message,
            { role: "tool", tool_call_id: call.id, content: "lookup-result" },
          ],
          tools,
          stream: true,
        });
        let answer = "";
        for await (const event of second) answer += event.choices[0]?.delta.content ?? "";
        expect(answer).toBe("Model instance reached.");
      }
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("lookup-result");
    } finally {
      await server.close();
      await provider.close();
    }
  },
);

it("OpenAI-compatible preset rewrites the upstream model and uses the configured credentials", async () => {
  const preset = openAICompatibleModel({
    baseURL: "https://provider.test/v1",
    apiKey: "provider-secret",
    model: "provider-model",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://provider.test/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
      expect(JSON.parse(String(init?.body)).model).toBe("provider-model");
      return new Response(
        'data: {"id":"chat_test","object":"chat.completion.chunk","created":1,"model":"provider-model","choices":[{"index":0,"delta":{"content":"Compatible model reached."},"finish_reason":null}]}\n\ndata: {"id":"chat_test","object":"chat.completion.chunk","created":1,"model":"provider-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const response = await preset.fetch(
    new Request("https://gateway.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "primary", input: "Hello" }),
    }),
  );
  expect(await response.text()).toContain("Compatible model reached.");
});

it("native passthrough preserves opaque content, enforces protocol, and replaces auth", async () => {
  let calls = 0;
  const preset = nativeModel({
    protocol: "anthropic",
    baseURL: "https://provider.test/v1",
    apiKey: "provider-secret",
    model: "provider-model",
    fetch: async (input, init) => {
      calls++;
      const request = new Request(input, init);
      expect(request.url).toBe("https://provider.test/v1/messages");
      expect(request.redirect).toBe("manual");
      const headers = request.headers;
      expect(headers.get("x-api-key")).toBe("provider-secret");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("anthropic-beta")).toBe("fixture-beta");
      expect(await request.json()).toEqual({
        model: "provider-model",
        opaque_extension: { signed: "payload" },
      });
      return Response.json({ opaque_result: "preserved" });
    },
  });
  const gateway = createModelGateway(() => ({ primary: preset }));
  const request = (path: string, model = "primary") =>
    new Request(`https://gateway.test/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer caller-secret",
        cookie: "private",
        "anthropic-beta": "fixture-beta",
      },
      body: JSON.stringify({ model, opaque_extension: { signed: "payload" } }),
    });
  expect(await (await gateway.fetch(request("messages"), {})).json()).toEqual({
    opaque_result: "preserved",
  });
  expect((await gateway.fetch(request("responses"), {})).status).toBe(400);
  expect((await gateway.fetch(request("messages", "missing"), {})).status).toBe(404);
  expect(calls).toBe(1);
});

it("rejects unsupported/oversized input before inference and never completes truncated output", async () => {
  let calls = 0;
  const gateway = createModelGateway(() => ({
    primary: aiSDKModel(
      new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "finish", finishReason: { unified: "length", raw: undefined }, usage },
              ],
            }),
          };
        },
      }),
    ),
  }));
  const request = (body: unknown) =>
    new Request("https://gateway.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "primary", ...(body as object) }),
    });
  expect(
    (
      await gateway.fetch(
        request({ input: [{ type: "reasoning", encrypted_content: "opaque" }] }),
        {},
      )
    ).status,
  ).toBe(400);
  expect((await gateway.fetch(request({ input: "x".repeat(4 * 1024 * 1024) }), {})).status).toBe(
    413,
  );
  expect(calls).toBe(0);
  expect((await gateway.fetch(request({ input: "Hello" }), {})).status).toBe(503);
  const streaming = await gateway.fetch(request({ input: "Hello", stream: true }), {});
  const body = await streaming.text();
  expect(body).toContain("response.failed");
  expect(body).not.toContain("response.completed");
});

it("cancelling a gateway stream aborts the in-flight AI SDK model call", async () => {
  let signal: AbortSignal | undefined;
  const started = Promise.withResolvers<void>();
  const gateway = createModelGateway(() => ({
    primary: aiSDKModel(
      new MockLanguageModelV4({
        doStream: async (options) => {
          signal = options.abortSignal;
          started.resolve();
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                signal?.addEventListener("abort", () => controller.close(), { once: true });
              },
            }),
          };
        },
      }),
    ),
  }));
  const response = await gateway.fetch(
    new Request("https://gateway.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "primary", input: "Hello", stream: true }),
    }),
    {},
  );
  if (!response.body) throw new Error("Missing stream");
  const reader = response.body.getReader();
  await reader.read();
  await started.promise;
  await reader.cancel();
  expect(signal?.aborted).toBe(true);
});

const answerSchema = {
  type: "object" as const,
  properties: { answer: { type: "number" } },
  required: ["answer"],
  additionalProperties: false,
};
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

it.each(["responses", "anthropic", "chat-completions"] as const)(
  "%s forwards reasoning effort and structured output to the AI SDK model",
  async (protocol) => {
    const calls: { reasoning: unknown; responseFormat: unknown }[] = [];
    const gateway = createModelGateway(() => ({
      primary: aiSDKModel(
        new MockLanguageModelV4({
          doStream: async (options) => {
            calls.push({ reasoning: options.reasoning, responseFormat: options.responseFormat });
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "msg_answer" },
                  { type: "text-delta", id: "msg_answer", delta: '{"answer":42}' },
                  { type: "text-end", id: "msg_answer" },
                  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
                ],
              }),
            };
          },
        }),
      ),
    }));
    const server = await serveFetch((request) => gateway.fetch(request, {}));
    const client = new OpenAI({ apiKey: "fixture", baseURL: `${server.url}/v1`, maxRetries: 0 });
    try {
      let text: string | undefined;
      if (protocol === "responses") {
        const response = await client.responses.create({
          model: "primary",
          input: "Answer with JSON",
          reasoning: { effort: "high" },
          text: {
            format: { type: "json_schema", name: "answer", schema: answerSchema, strict: true },
          },
          store: false,
        });
        const message = response.output.find((item) => item.type === "message");
        const part = message?.content[0];
        text = part?.type === "output_text" ? part.text : undefined;
      } else if (protocol === "anthropic") {
        const anthropic = new Anthropic({ apiKey: "fixture", baseURL: server.url, maxRetries: 0 });
        const response = await anthropic.messages.create({
          model: "primary",
          max_tokens: 100,
          messages: [{ role: "user", content: "Answer with JSON" }],
          thinking: { type: "enabled", budget_tokens: 40_000 },
          output_config: { format: { type: "json_schema", schema: answerSchema } },
        });
        const part = response.content[0];
        text = part?.type === "text" ? part.text : undefined;
        // An explicit output_config.effort takes precedence over a thinking budget.
        await anthropic.messages.create({
          model: "primary",
          max_tokens: 100,
          messages: [{ role: "user", content: "Again" }],
          thinking: { type: "enabled", budget_tokens: 40_000 },
          output_config: { effort: "low" },
        });
        expect(calls[1]?.reasoning).toBe("low");
        expect(calls[1]?.responseFormat).toBeUndefined();
      } else {
        const response = await client.chat.completions.create({
          model: "primary",
          messages: [{ role: "user", content: "Answer with JSON" }],
          reasoning_effort: "high",
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", schema: answerSchema },
          },
        });
        text = response.choices[0]?.message.content ?? undefined;
      }
      expect(text).toBe('{"answer":42}');
      expect(calls[0]?.reasoning).toBe("high");
      expect(calls[0]?.responseFormat).toMatchObject({ type: "json", schema: answerSchema });
    } finally {
      await server.close();
    }
  },
);

it("OpenAI-compatible preset sends reasoning_effort and a json_schema response format", async () => {
  const preset = openAICompatibleModel({
    baseURL: "https://provider.test/v1",
    apiKey: "provider-secret",
    model: "provider-model",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning_effort).toBe("medium");
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "answer", schema: answerSchema },
      });
      return new Response(
        'data: {"id":"chat_test","object":"chat.completion.chunk","created":1,"model":"provider-model","choices":[{"index":0,"delta":{"content":"{\\"answer\\":42}"},"finish_reason":null}]}\n\ndata: {"id":"chat_test","object":"chat.completion.chunk","created":1,"model":"provider-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const response = await preset.fetch(
    new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "primary",
        messages: [{ role: "user", content: "Answer with JSON" }],
        reasoning_effort: "medium",
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", schema: answerSchema },
        },
      }),
    }),
  );
  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  expect(body.choices[0]?.message.content).toBe('{"answer":42}');
});

it.each(["responses", "anthropic"] as const)(
  "%s image input reaches the AI SDK model as a file part",
  async (protocol) => {
    const prompts: string[] = [];
    const gateway = createModelGateway(() => ({
      primary: aiSDKModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            prompts.push(JSON.stringify(prompt));
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "msg_answer" },
                  { type: "text-delta", id: "msg_answer", delta: "A pixel." },
                  { type: "text-end", id: "msg_answer" },
                  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
                ],
              }),
            };
          },
        }),
      ),
    }));
    const body =
      protocol === "responses"
        ? {
            model: "primary",
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "Describe" },
                  {
                    type: "input_image",
                    image_url: `data:image/png;base64,${png}`,
                    detail: "auto",
                  },
                ],
              },
            ],
          }
        : {
            model: "primary",
            max_tokens: 100,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
                ],
              },
            ],
          };
    const response = await gateway.fetch(
      new Request(
        `https://gateway.test/v1/${protocol === "responses" ? "responses" : "messages"}`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
      {},
    );
    expect(response.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"type":"file"');
    expect(prompts[0]).toContain(png);
  },
);

it("native Anthropic passthrough streams server tool blocks unchanged", async () => {
  const upstream =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"provider-model","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"fixture\\"}"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://example.test","title":"Fixture","encrypted_content":"opaque","page_age":null}]}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const preset = nativeModel({
    protocol: "anthropic",
    baseURL: "https://provider.test/v1",
    apiKey: "provider-secret",
    model: "provider-model",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("anthropic-beta")).toBe("web-search-fixture");
      const body = await request.json<{ tools?: { type?: string }[] }>();
      expect(body.tools?.[0]?.type).toBe("web_search_20250305");
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const gateway = createModelGateway(() => ({ primary: preset }));
  const response = await gateway.fetch(
    new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: { "anthropic-beta": "web-search-fixture" },
      body: JSON.stringify({
        model: "primary",
        stream: true,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: "Search" }],
      }),
    }),
    {},
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toBe(upstream);
});
