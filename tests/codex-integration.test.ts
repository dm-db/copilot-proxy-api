import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { copilotFetch } from "~/lib/copilot-fetch"
import { state } from "~/lib/state"
import { responsesRoutes } from "~/routes/responses/route"
import { createResponses } from "~/services/copilot/create-responses"
import { validateResponsesCapabilities } from "~/services/copilot/responses-capabilities"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  state.models = undefined
})

function setup(): void {
  state.copilotToken = "test-token"
  state.accountType = "individual"
  state.vsCodeVersion = "1.0.0"
}

function sse(events: Array<unknown>): Uint8Array {
  return new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  )
}

test("recovers decrypt failures after 100ms and more than eight provisional events", async () => {
  setup()
  const calls: Array<string> = []
  globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON")
    calls.push(init.body)
    const stale = init.body.includes("delayed-ciphertext")
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sse(
                Array.from({ length: 12 }, () => ({
                  type: "response.in_progress",
                })),
              ),
            )
            setTimeout(() => {
              controller.enqueue(
                sse(
                  stale ?
                    [
                      { type: "response.failed", response: { error: null } },
                      {
                        type: "error",
                        message:
                          "Encrypted function output content could not be decrypted or decoded.",
                      },
                    ]
                  : [
                      {
                        type: "response.completed",
                        response: { status: "completed" },
                      },
                    ],
                ),
              )
              controller.close()
            }, 150)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  }) as unknown as typeof fetch
  const response = await createResponses({
    model: "gpt-6.1-sol",
    stream: true,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Readable result" },
          {
            type: "encrypted_content",
            encrypted_content: "delayed-ciphertext",
          },
        ],
      },
    ],
  })
  expect(await response.text()).toContain("response.completed")
  expect(calls).toHaveLength(2)
  expect(calls[1]).not.toContain("delayed-ciphertext")
  expect(calls[1]).toContain("Readable result")
})

test("converts delayed streamed context errors to a Codex context-length HTTP error", async () => {
  setup()
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        sse([
          { type: "response.created" },
          { type: "response.failed", response: { error: null } },
          {
            type: "error",
            code: "context_length_exceeded",
            message:
              "maximum context length is 100 tokens; resulted in 120 tokens",
          },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
    ),
  ) as unknown as typeof fetch
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  const response = await app.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6.1-sol",
      stream: true,
      input: "hello",
    }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: "context_length_exceeded" },
  })
  const codexResponse = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "codex_cli_rs/0.162.0",
    },
    body: JSON.stringify({
      model: "gpt-6.1-sol",
      stream: true,
      input: "hello",
    }),
  })
  expect(codexResponse.headers.get("content-type")).toBe("text/event-stream")
  expect(await codexResponse.text()).toContain(
    '"code":"context_length_exceeded"',
  )
})

test("does not retry an aborted upstream request", async () => {
  const cancellation = new AbortController()
  const fetchMock = mock(() => {
    cancellation.abort()
    return Promise.reject(new DOMException("Request aborted", "AbortError"))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  try {
    await copilotFetch("https://api.githubcopilot.com/responses", {
      signal: cancellation.signal,
    })
  } catch {
    /* expected abort */
  }
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("cancelling the response body aborts Copilot fetch", async () => {
  setup()
  let signal: AbortSignal | null | undefined
  globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
    signal = init?.signal
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sse([{ type: "response.output_text.delta", delta: "hello" }]),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  }) as unknown as typeof fetch
  const response = await createResponses({
    model: "gpt-6.1-sol",
    stream: true,
    input: "hello",
  })
  await response.body?.cancel()
  expect(signal?.aborted).toBe(true)
})

test("client abort stops provisional inspection before output", async () => {
  setup()
  const cancellation = new AbortController()
  const cancel = mock(() => undefined)
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sse([{ type: "response.created" }]))
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    ),
  ) as unknown as typeof fetch
  const response = createResponses(
    { model: "gpt-6.1-sol", stream: true, input: "hello" },
    cancellation.signal,
  )
  setTimeout(() => cancellation.abort(), 20)
  let caught = false
  try {
    await response
  } catch {
    caught = true
  }
  expect(caught).toBe(true)
  expect(cancel).toHaveBeenCalled()
})

test("rejects unsupported effort only when upstream advertises allowed levels", () => {
  setup()
  state.models = {
    object: "list",
    data: [
      {
        id: "test",
        object: "model",
        name: "test",
        vendor: "openai",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "test",
          object: "model_capabilities",
          type: "chat",
          tokenizer: "o200k_base",
          limits: {},
          supports: { reasoning_effort: ["low", "high"] },
        },
      },
    ],
  }
  expect(() =>
    validateResponsesCapabilities({
      model: "test",
      input: "hello",
      reasoning: { effort: "max" },
    }),
  ).toThrow("Unsupported reasoning effort")
  expect(() =>
    validateResponsesCapabilities({
      model: "unknown",
      input: "hello",
      reasoning: { effort: "max" },
    }),
  ).not.toThrow()
})
