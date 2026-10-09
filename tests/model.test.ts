import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamResult, streamEvents } from "./helpers/openai";
vi.mock("../src/lib/inputs", () => ({
  registeredInputs: () => ({
    spec: "spec",
    bank: { guardrails: {}, generation_policy: {} },
    bankVersion: "3.3",
    specVersion: "2.2",
    bankHash: "bank",
    specHash: "spec",
  }),
}));
vi.mock("../src/lib/bank", () => ({ specSections: () => "Requirements" }));
vi.mock("../src/lib/db", () => ({
  exec: vi.fn(),
  now: () => "now",
  uid: () => "id",
}));
vi.mock("../src/lib/openai-auth", () => ({
  activeAccount: () => ({ client_id: "test-client" }),
  accessToken: async () => "test-token",
  modelName: vi.fn((strong: boolean) =>
    strong ? "account-strong" : "account-fast",
  ),
}));
import { callModel } from "../src/lib/model";
import { completedResponse } from "../src/lib/openai-stream";
import { modelName } from "../src/lib/openai-auth";
const schema = z.object({ value: z.number() });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("OpenAI Responses compatibility", () => {
  it.each(["api", "chatgpt"])(
    "shows setup guidance for the selected access mode (%s)",
    async (mode) => {
      vi.stubEnv("OPENAI_AUTH_MODE", mode);
      vi.mocked(modelName).mockReturnValueOnce("");
      await expect(callModel("extract posting", schema, {})).rejects.toThrow(
        mode === "api" ? "Configure OPENAI_API_KEY" : "Sign in and choose",
      );
    },
  );
  it.each([false, true])(
    "uses account models and the ChatGPT plan request contract (strong=%s)",
    async (strong) => {
      const fetcher = vi.fn().mockResolvedValue(streamResult({ value: 7 }));
      vi.stubGlobal("fetch", fetcher);
      expect(
        await callModel("reword documents", schema, {}, { strong }),
      ).toEqual({ value: 7 });
      const [url, request] = fetcher.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.Authorization).toBe("Bearer test-token");
      const body = JSON.parse(request.body);
      expect(body.model).toBe(strong ? "account-strong" : "account-fast");
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.input).toEqual([{ role: "user", content: "{}" }]);
      expect(body.instructions).toContain(
        "Call structured_result exactly once",
      );
      for (const key of [
        "max_output_tokens",
        "temperature",
        "previous_response_id",
        "metadata",
      ])
        expect(body).not.toHaveProperty(key);
      expect(body.tools[0].type).toBe("namespace");
      expect(body.tools[0].tools[0].parameters.properties.value.type).toBe(
        "number",
      );
      expect(body.tool_choice).toBe("required");
    },
  );
  it("retries schema failures and rejects responses without a structured result", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(streamResult({ value: "invalid" }))
      .mockResolvedValueOnce(streamResult({ value: 8 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await callModel("extract posting", schema, {})).toEqual({
      value: 8,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset().mockImplementation(async () =>
      streamEvents([
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]),
    );
    await expect(callModel("extract posting", schema, {})).rejects.toThrow(
      "exactly one",
    );
  });
  it("does not immediately retry a timeout", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Request timeout"));
    vi.stubGlobal("fetch", fetcher);
    await expect(callModel("extract posting", schema, {})).rejects.toThrow(
      "timeout",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("handles SSE split across network chunks and ignores deltas until completion", async () => {
    const body =
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3)
          controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    expect((await completedResponse(new Response(stream))).status).toBe(
      "completed",
    );
  });
  it("retains completed output items when the final plan event omits output", async () => {
    const response = await completedResponse(
      streamEvents([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            namespace: "job_finder",
            name: "structured_result",
            arguments: JSON.stringify({ value: 9 }),
          },
        },
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]),
    );
    expect(response.output).toEqual([
      expect.objectContaining({
        type: "function_call",
        name: "structured_result",
        arguments: JSON.stringify({ value: 9 }),
      }),
    ]);
  });
  it("retains completed function-call arguments when no output item is sent", async () => {
    const response = await completedResponse(
      streamEvents([
        {
          type: "response.function_call_arguments.done",
          name: "structured_result",
          arguments: JSON.stringify({ value: 10 }),
        },
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]),
    );
    expect(response.output).toEqual([
      expect.objectContaining({
        type: "function_call",
        name: "structured_result",
        arguments: JSON.stringify({ value: 10 }),
      }),
    ]);
  });
  it.each(["response.failed", "response.incomplete"])(
    "rejects %s after streaming starts",
    async (type) => {
      await expect(
        completedResponse(
          streamEvents([
            {
              type,
              response: {
                status: "failed",
                output: [],
                error: { code: "subscription_sharing_usage_limit_exceeded" },
              },
            },
          ]),
        ),
      ).rejects.toThrow("usage limit");
    },
  );
  it("rejects interrupted streams", async () => {
    await expect(
      completedResponse(
        streamEvents([
          { type: "response.output_text.delta", delta: "unfinished" },
        ]),
      ),
    ).rejects.toThrow("without a completed");
  });
});
