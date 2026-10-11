import { createHash } from "node:crypto"

import type {
  ResponsesApiRequest,
  ResponsesInputItem,
} from "~/routes/responses/types"

const ENCRYPTED_OUTPUT_ERROR =
  "Encrypted function output content could not be decrypted or decoded."
const MAX_REJECTED_ENCRYPTED_OUTPUTS = 256
const REJECTED_ENCRYPTED_OUTPUT_TTL_MS = 30 * 60 * 1000
const MAX_STREAM_FAILURE_INSPECTION_BYTES = 64 * 1024
const rejectedEncryptedOutputs = new Map<string, number>()

export function createEncryptedOutputScope(
  url: string,
  model: string,
  accountIdentity: string,
): string {
  return fingerprintEncryptedOutput(`${url}\0${model}\0${accountIdentity}`)
}

export function isEncryptedOutputError(
  response: Response,
  errorBody: string,
): boolean {
  return response.status === 400 && errorBody.includes(ENCRYPTED_OUTPUT_ERROR)
}

export async function inspectResponsesStreamFailure(
  response: Response,
  signal?: AbortSignal,
): Promise<{ failed: boolean; response: Response; errorBody?: string }> {
  signal?.throwIfAborted()
  if (!response.body) return { failed: false, response }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return { failed: false, response }
  }

  // Bun's clone/body buffering can consume the original stream reader. Tee
  // explicitly and forward the untouched branch rather than reading a clone.
  const [inspection, forwarded] = (
    response.body as ReadableStream<Uint8Array>
  ).tee()
  const reader = inspection.getReader()
  const replay = new Response(forwarded, response)
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined)
    void forwarded.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener("abort", abort, { once: true })

  try {
    const errorBody = await readImmediateEncryptedOutputStreamFailure(reader)
    signal?.throwIfAborted()
    return {
      failed: errorBody?.includes(ENCRYPTED_OUTPUT_ERROR) ?? false,
      errorBody,
      response: replay,
    }
  } catch (error) {
    void forwarded.cancel(error).catch(() => undefined)
    throw error
  } finally {
    signal?.removeEventListener("abort", abort)
    void reader.cancel().catch(() => undefined)
  }
}

export function stripEncryptedOutputParts(
  payload: ResponsesApiRequest,
  selected?: (fingerprint: string) => boolean,
): {
  count: number
  fingerprints: Array<string>
  payload: ResponsesApiRequest
} {
  if (typeof payload.input === "string") {
    return { count: 0, fingerprints: [], payload }
  }

  let count = 0
  const fingerprints: Array<string> = []
  let input: Array<ResponsesInputItem> | undefined
  for (const [index, item] of payload.input.entries()) {
    if (!Array.isArray(item.content)) continue
    const hasReadableText = item.content.some(
      (part) =>
        (part.type === "input_text" || part.type === "output_text")
        && typeof part.text === "string",
    )
    if (!hasReadableText) continue

    const content = item.content.filter((part) => {
      if (
        part.type !== "encrypted_content"
        || typeof part.encrypted_content !== "string"
      ) {
        return true
      }
      const fingerprint = fingerprintEncryptedOutput(part.encrypted_content)
      if (selected && !selected(fingerprint)) return true
      fingerprints.push(fingerprint)
      return false
    })
    if (content.length === item.content.length || content.length === 0) continue

    count += item.content.length - content.length
    input ??= [...payload.input]
    input[index] = { ...item, content }
  }

  return {
    count,
    fingerprints,
    payload: input ? { ...payload, input } : payload,
  }
}

export function isRejectedEncryptedOutput(
  scope: string,
  fingerprint: string,
): boolean {
  const key = rejectedEncryptedOutputKey(scope, fingerprint)
  const expiresAt = rejectedEncryptedOutputs.get(key)
  if (!expiresAt) return false
  if (expiresAt > Date.now()) return true

  rejectedEncryptedOutputs.delete(key)
  return false
}

export function rememberRejectedEncryptedOutputs(
  scope: string,
  fingerprints: Array<string>,
): void {
  if (fingerprints.length !== 1) return

  const key = rejectedEncryptedOutputKey(scope, fingerprints[0])
  rejectedEncryptedOutputs.delete(key)
  rejectedEncryptedOutputs.set(
    key,
    Date.now() + REJECTED_ENCRYPTED_OUTPUT_TTL_MS,
  )
  while (rejectedEncryptedOutputs.size > MAX_REJECTED_ENCRYPTED_OUTPUTS) {
    const oldest = rejectedEncryptedOutputs.keys().next().value
    if (!oldest) break
    rejectedEncryptedOutputs.delete(oldest)
  }
}

async function readImmediateEncryptedOutputStreamFailure(reader: {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}): Promise<string | undefined> {
  const decoder = new TextDecoder()
  let buffer = ""
  let bytesRead = 0

  while (true) {
    const result = await reader.read()

    const { done, value } = result
    if (value) {
      bytesRead += value.byteLength
      if (bytesRead > MAX_STREAM_FAILURE_INSPECTION_BYTES) return undefined
      buffer += decoder.decode(value, { stream: !done })
    } else if (done) {
      buffer += decoder.decode()
    }

    while (true) {
      const next = takeNextSseBlock(buffer)
      if (!next) break
      buffer = next.remaining
      const event = parseResponseEvent(next.block)
      if (!event) continue

      const failure = recoverableFailure(event)
      if (failure) return failure
      if (!isProvisionalResponseEvent(event)) return undefined
    }

    if (done) {
      const event = parseResponseEvent(buffer)
      return event ? recoverableFailure(event) : undefined
    }
  }
}

function takeNextSseBlock(
  buffer: string,
): { block: string; remaining: string } | undefined {
  const boundary = /\r\n\r\n|\r\r|\n\n/.exec(buffer)
  if (boundary?.index === undefined) return undefined

  return {
    block: buffer.slice(0, boundary.index),
    remaining: buffer.slice(boundary.index + boundary[0].length),
  }
}

interface ResponseStreamEvent {
  type?: unknown
  [key: string]: unknown
}

function parseResponseEvent(block: string): ResponseStreamEvent | undefined {
  const data = block
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return undefined

  try {
    const event = JSON.parse(data) as unknown
    return event && typeof event === "object" ?
        (event as ResponseStreamEvent)
      : undefined
  } catch {
    return undefined
  }
}

function recoverableFailure(event: ResponseStreamEvent): string | undefined {
  if (event.type !== "response.failed" && event.type !== "error")
    return undefined
  const body = JSON.stringify(event)
  if (
    body.includes(ENCRYPTED_OUTPUT_ERROR)
    || /context_length_exceeded|model_max_prompt_tokens_exceeded|maximum context length|prompt is too long/i.test(
      body,
    )
  ) {
    return body
  }
  return undefined
}

function isProvisionalResponseEvent(event: ResponseStreamEvent): boolean {
  return (
    event.type === "response.created"
    || event.type === "response.in_progress"
    || (event.type === "response.failed"
      && typeof event.response === "object"
      && event.response !== null
      && !(event.response as Record<string, unknown>).error)
  )
}

function fingerprintEncryptedOutput(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function rejectedEncryptedOutputKey(
  scope: string,
  fingerprint: string,
): string {
  return `${scope}:${fingerprint}`
}
