import consola from "consola"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { copilotFetch } from "~/lib/copilot-fetch"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  dropUnverifiableThinking,
  isInvalidSignatureError,
  rejectThinkingSignatures,
} from "~/services/copilot/legacy-thinking"

const NATIVE_MESSAGES_ENDPOINT = "/v1/messages"
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"

/** Headers from the client request that Copilot's native endpoint understands. */
export interface AnthropicClientHeaders {
  beta?: string
  version?: string
}

/**
 * Copilot serves some Claude models on a native Anthropic `/v1/messages`
 * endpoint. Unlike `/chat/completions`, it honours `anthropic-beta`
 * (e.g. `context-1m-2025-08-07`), so the full 1M context window is usable.
 * Set COPILOT_NATIVE_MESSAGES=0 to disable and use the translated path.
 */
export function supportsNativeMessages(model: Model | undefined): boolean {
  if (process.env.COPILOT_NATIVE_MESSAGES === "0") return false
  return model?.supported_endpoints?.includes(NATIVE_MESSAGES_ENDPOINT) ?? false
}

/**
 * Forward an Anthropic Messages payload to Copilot unchanged. Returns the raw
 * upstream response (JSON or SSE) so it can be piped back to the client.
 */
export async function createNativeMessages(
  payload: AnthropicMessagesPayload,
  clientHeaders: AnthropicClientHeaders,
): Promise<Response> {
  const prepared = dropUnverifiableThinking(payload)
  const response = await postNativeMessages(prepared, clientHeaders)
  if (response.ok) return response

  const errorBody = await response.text()
  if (isInvalidSignatureError(response, errorBody)) {
    const rejected = rejectThinkingSignatures(prepared)
    if (rejected > 0) {
      consola.warn(
        `Copilot rejected ${rejected} thinking signature(s) from the translated path; retrying without them`,
      )
      const retried = await postNativeMessages(
        dropUnverifiableThinking(prepared),
        clientHeaders,
      )
      if (retried.ok) return retried
      throw await toHTTPError("Failed to create native messages", retried)
    }
  }
  throw httpError("Failed to create native messages", response, errorBody)
}

async function postNativeMessages(
  payload: AnthropicMessagesPayload,
  clientHeaders: AnthropicClientHeaders,
): Promise<Response> {
  const body = JSON.stringify(payload)
  consola.debug(
    `Sending native messages payload: ${body.length} bytes, ${payload.messages.length} messages, model: ${payload.model}`,
  )

  return await copilotFetch(
    `${copilotBaseUrl(state)}${NATIVE_MESSAGES_ENDPOINT}`,
    {
      method: "POST",
      headers: {
        ...nativeHeaders(payload, clientHeaders),
        accept: payload.stream ? "text/event-stream" : "application/json",
        "X-Initiator": isAgentCall(payload) ? "agent" : "user",
      },
      body,
    },
  )
}

/** Ask Copilot's native endpoint for the prompt's input token count. */
export async function countNativeTokens(
  payload: AnthropicMessagesPayload,
  clientHeaders: AnthropicClientHeaders,
): Promise<number> {
  const response = await copilotFetch(
    `${copilotBaseUrl(state)}${NATIVE_MESSAGES_ENDPOINT}/count_tokens`,
    {
      method: "POST",
      headers: nativeHeaders(payload, clientHeaders),
      body: JSON.stringify(dropUnverifiableThinking(payload)),
    },
  )

  if (!response.ok) {
    throw await toHTTPError("Failed to count native tokens", response)
  }
  const result = (await response.json()) as { input_tokens?: unknown }
  if (typeof result.input_tokens !== "number") {
    throw new TypeError("Copilot count_tokens response has no input_tokens")
  }
  return result.input_tokens
}

function nativeHeaders(
  payload: AnthropicMessagesPayload,
  clientHeaders: AnthropicClientHeaders,
): Record<string, string> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, hasImages(payload)),
    "anthropic-version": clientHeaders.version ?? DEFAULT_ANTHROPIC_VERSION,
  }
  if (clientHeaders.beta) headers["anthropic-beta"] = clientHeaders.beta
  return headers
}

function hasImages(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some(
        (block) =>
          block.type === "image"
          || (block.type === "tool_result" && toolResultHasImage(block)),
      ),
  )
}

// The local type says tool_result content is a string, but Claude Code also
// sends block arrays (e.g. screenshots from tools).
function toolResultHasImage(block: { content: unknown }): boolean {
  return (
    Array.isArray(block.content)
    && block.content.some(
      (part) =>
        typeof part === "object"
        && part !== null
        && (part as { type?: unknown }).type === "image",
    )
  )
}

// Mirrors createChatCompletions: any assistant turn or tool result means the
// request continues an agent loop rather than starting from a user prompt.
function isAgentCall(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      message.role === "assistant"
      || (Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result")),
  )
}

async function toHTTPError(
  message: string,
  response: Response,
): Promise<HTTPError> {
  return httpError(message, response, await response.text())
}

function httpError(
  message: string,
  response: Response,
  errorBody: string,
): HTTPError {
  consola.error(`${message} - Status: ${response.status}: ${errorBody}`)
  return new HTTPError(
    message,
    new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  )
}
