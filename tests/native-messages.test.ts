import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { messageRoutes } from "~/routes/messages/route"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const NATIVE_URL = "https://api.githubcopilot.com/v1/messages"
const CHAT_URL = "https://api.githubcopilot.com/chat/completions"

afterEach(() => {
  mock.restore()
  state.models = undefined
  delete process.env.COPILOT_NATIVE_MESSAGES
})

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  return app
}

function setModels(models: Array<{ endpoints?: Array<string>; id: string }>) {
  state.models = {
    object: "list",
    data: models.map(({ endpoints, id }) => ({
      id,
      object: "model",
      name: id,
      model_picker_enabled: true,
      preview: false,
      vendor: "Anthropic",
      version: id,
      supported_endpoints: endpoints,
      capabilities: {
        family: id,
        limits: {
          max_context_window_tokens: 200_000,
          max_output_tokens: 64_000,
          max_prompt_tokens: 200_000,
        },
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    })),
  } satisfies ModelsResponse
}

const NATIVE_MODEL = {
  id: "claude-opus-5.5",
  endpoints: ["/v1/messages", "/chat/completions"],
}

interface FetchCall {
  body: string
  headers: Record<string, string>
  url: string
}

function mockFetch(respond: (call: FetchCall) => Response): Array<FetchCall> {
  const calls: Array<FetchCall> = []
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    const call = {
      url,
      body: init.body as string,
      headers: init.headers as Record<string, string>,
    }
    calls.push(call)
    return Promise.resolve(respond(call))
  }) as unknown as typeof fetch
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const upstreamMessage = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5.5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 1 },
  copilot_usage: { total_nano_aiu: 1 },
}

function postMessages(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  path = "/v1/messages",
) {
  return createApp().request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("native /v1/messages pass-through", () => {
  test("forwards the Anthropic payload untouched except for the model id", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse(upstreamMessage))

    const payload = {
      model: "claude-opus-5-5",
      max_tokens: 100,
      system: [
        { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
    }
    const response = await postMessages(payload)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(NATIVE_URL)
    expect(JSON.parse(calls[0].body)).toEqual({
      ...payload,
      model: "claude-opus-5.5",
    })
    expect(await response.json()).toEqual(upstreamMessage)
  })

  test("forwards anthropic-beta and anthropic-version headers", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse(upstreamMessage))

    await postMessages(
      {
        model: "claude-opus-5.5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      },
      {
        "anthropic-beta": "context-1m-2025-08-07,claude-code-20250219",
        "anthropic-version": "2023-06-01",
      },
    )

    expect(calls[0].headers["anthropic-beta"]).toBe(
      "context-1m-2025-08-07,claude-code-20250219",
    )
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01")
    expect(calls[0].headers.Authorization).toBe("Bearer test-token")
  })

  test("defaults anthropic-version when the client omits it", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse(upstreamMessage))

    await postMessages({
      model: "claude-opus-5.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01")
    expect(calls[0].headers["anthropic-beta"]).toBeUndefined()
  })

  test("marks requests with assistant turns as agent-initiated", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse(upstreamMessage))

    await postMessages({
      model: "claude-opus-5.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    })
    await postMessages({
      model: "claude-opus-5.5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
      ],
    })

    expect(calls[0].headers["X-Initiator"]).toBe("user")
    expect(calls[1].headers["X-Initiator"]).toBe("agent")
  })

  test("does not trim prompts larger than max_prompt_tokens", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse(upstreamMessage))

    // ~1.5 MB of text, far above what fitContext allows for a 200k model.
    const big = "word ".repeat(300_000)
    const payload = {
      model: "claude-opus-5.5",
      max_tokens: 100,
      messages: [
        { role: "user", content: big },
        { role: "assistant", content: "ok" },
        { role: "user", content: "summarize" },
      ],
    }
    await postMessages(payload)

    expect(calls[0].url).toBe(NATIVE_URL)
    expect(JSON.parse(calls[0].body)).toEqual(payload)
  })

  test("streams the upstream SSE body through unchanged", async () => {
    setModels([NATIVE_MODEL])
    const sse =
      'event: message_start\ndata: {"type":"message_start"}\n\n'
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const calls = mockFetch(
      () =>
        new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    )

    const response = await postMessages({
      model: "claude-opus-5.5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(calls[0].url).toBe(NATIVE_URL)
    expect(calls[0].headers.accept).toBe("text/event-stream")
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(await response.text()).toBe(sse)
  })

  test("returns upstream errors with their status", async () => {
    setModels([NATIVE_MODEL])
    const error = {
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long" },
    }
    mockFetch(() => jsonResponse(error, 400))

    const response = await postMessages({
      model: "claude-opus-5.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(error)
  })

  test("uses /chat/completions for models without /v1/messages", async () => {
    setModels([{ id: "claude-opus-5.5", endpoints: ["/chat/completions"] }])
    const calls = mockFetch(() =>
      jsonResponse({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "claude-opus-5.5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
    )

    const response = await postMessages({
      model: "claude-opus-5.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(response.status).toBe(200)
    expect(calls[0].url).toBe(CHAT_URL)
  })

  test("COPILOT_NATIVE_MESSAGES=0 falls back to /chat/completions", async () => {
    process.env.COPILOT_NATIVE_MESSAGES = "0"
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() =>
      jsonResponse({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "claude-opus-5.5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
    )

    await postMessages({
      model: "claude-opus-5.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(calls[0].url).toBe(CHAT_URL)
  })
})

// Signatures are remembered across requests, so every test uses its own.
function conversation(signature: string | undefined) {
  return {
    model: "claude-opus-5.5",
    max_tokens: 100,
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature },
          { type: "text", text: "hi" },
        ],
      },
      { role: "user", content: "again" },
    ],
  }
}

function sentAssistantContent(call: FetchCall): unknown {
  const body = JSON.parse(call.body) as {
    messages: Array<{ content: unknown }>
  }
  return body.messages[1].content
}

describe("thinking blocks from the translated path", () => {
  const SIGNATURE_ERROR = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "messages.1.content.0: Invalid signature in thinking block",
    },
  }

  test("keeps signed thinking blocks", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse(upstreamMessage))

    await postMessages(conversation("native-sig-keep"))

    expect(calls).toHaveLength(1)
    expect(sentAssistantContent(calls[0])).toEqual([
      { type: "thinking", thinking: "hmm", signature: "native-sig-keep" },
      { type: "text", text: "hi" },
    ])
  })

  test("drops thinking blocks without a signature", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse(upstreamMessage))

    const response = await postMessages(conversation(undefined))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(sentAssistantContent(calls[0])).toEqual([
      { type: "text", text: "hi" },
    ])
  })

  test("retries without thinking blocks when Copilot rejects a signature", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch((call) =>
      call.body.includes("legacy-sig-retry") ?
        jsonResponse(SIGNATURE_ERROR, 400)
      : jsonResponse(upstreamMessage),
    )

    const response = await postMessages(conversation("legacy-sig-retry"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(upstreamMessage)
    expect(calls).toHaveLength(2)
    expect(sentAssistantContent(calls[1])).toEqual([
      { type: "text", text: "hi" },
    ])
  })

  test("recognises the backtick wording of the signature error", async () => {
    setModels([NATIVE_MODEL])
    const error = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "messages.1.content.0: Invalid `signature` in `thinking` block",
      },
    }
    const calls = mockFetch((call) =>
      call.body.includes("legacy-sig-backtick") ?
        jsonResponse(error, 400)
      : jsonResponse(upstreamMessage),
    )

    const response = await postMessages(conversation("legacy-sig-backtick"))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  test("drops rejected signatures up front on later requests", async () => {
    setModels([NATIVE_MODEL])
    mockFetch((call) =>
      call.body.includes("legacy-sig-later") ?
        jsonResponse(SIGNATURE_ERROR, 400)
      : jsonResponse(upstreamMessage),
    )
    await postMessages(conversation("legacy-sig-later"))

    const calls = mockFetch((call) =>
      call.body.includes("legacy-sig-later") ?
        jsonResponse(SIGNATURE_ERROR, 400)
      : jsonResponse(upstreamMessage),
    )
    const response = await postMessages(conversation("legacy-sig-later"))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  test("does not retry other invalid_request_errors", async () => {
    setModels([NATIVE_MODEL])
    const error = {
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long" },
    }
    const calls = mockFetch(() => jsonResponse(error, 400))

    const response = await postMessages(conversation("native-sig-other"))

    expect(response.status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  test("drops unsigned thinking blocks before counting tokens", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse({ input_tokens: 7 }))

    await postMessages(conversation(undefined), {}, "/v1/messages/count_tokens")

    expect(calls).toHaveLength(1)
    expect(sentAssistantContent(calls[0])).toEqual([
      { type: "text", text: "hi" },
    ])
  })
})

describe("native /v1/messages/count_tokens pass-through", () => {
  const countPayload = {
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: "hello" }],
  }

  test("returns Copilot's count for native models", async () => {
    setModels([NATIVE_MODEL])
    const calls = mockFetch(() => jsonResponse({ input_tokens: 4242 }))

    const response = await postMessages(
      countPayload,
      { "anthropic-beta": "context-1m-2025-08-07" },
      "/v1/messages/count_tokens",
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${NATIVE_URL}/count_tokens`)
    expect(calls[0].headers["anthropic-beta"]).toBe("context-1m-2025-08-07")
    expect(JSON.parse(calls[0].body)).toEqual({
      ...countPayload,
      model: "claude-opus-5.5",
    })
    expect(await response.json()).toEqual({ input_tokens: 4242 })
  })

  test("falls back to the local estimate when Copilot's count fails", async () => {
    setModels([NATIVE_MODEL])
    mockFetch(() => jsonResponse({ error: "boom" }, 500))

    const response = await postMessages(
      countPayload,
      {},
      "/v1/messages/count_tokens",
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { input_tokens: number }
    expect(body.input_tokens).toBeGreaterThan(0)
  })

  test("does not call Copilot for models without /v1/messages", async () => {
    setModels([{ id: "claude-opus-5.5", endpoints: ["/chat/completions"] }])
    const calls = mockFetch(() => jsonResponse({ input_tokens: 1 }))

    const response = await postMessages(
      countPayload,
      {},
      "/v1/messages/count_tokens",
    )

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(0)
  })
})
