import { createHash } from "node:crypto"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"

// Thinking blocks produced by the translated /chat/completions path carry
// Copilot's `reasoning_opaque` as their signature (or none at all). The native
// /v1/messages endpoint rejects those, which breaks sessions that started on
// the translated path. Such blocks are dropped; rejected signatures are
// remembered so later requests of the same session do not fail first.
const INVALID_SIGNATURE_ERROR =
  /invalid\W+signature\W+in\W+(?:redacted_)?thinking/i
const MAX_REJECTED_SIGNATURES = 5000
const rejectedSignatures = new Set<string>()

interface ThinkingBlock {
  type: "thinking" | "redacted_thinking"
  signature?: string
  data?: string
}

export function isInvalidSignatureError(
  response: Response,
  errorBody: string,
): boolean {
  return response.status === 400 && INVALID_SIGNATURE_ERROR.test(errorBody)
}

/** Remember every thinking signature in the payload as rejected. */
export function rejectThinkingSignatures(
  payload: AnthropicMessagesPayload,
): number {
  let count = 0
  for (const block of thinkingBlocks(payload.messages)) {
    const signature = signatureOf(block)
    if (!signature) continue
    const fingerprint = fingerprintSignature(signature)
    rejectedSignatures.delete(fingerprint)
    rejectedSignatures.add(fingerprint)
    count++
  }
  while (rejectedSignatures.size > MAX_REJECTED_SIGNATURES) {
    const oldest = rejectedSignatures.values().next().value
    if (oldest === undefined) break
    rejectedSignatures.delete(oldest)
  }
  return count
}

/**
 * Drop assistant thinking blocks that the native endpoint cannot verify:
 * unsigned ones and ones whose signature was rejected before. Returns the
 * payload itself when nothing is dropped.
 */
export function dropUnverifiableThinking(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  let changed = false
  const messages: Array<AnthropicMessage> = []
  for (const message of payload.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      messages.push(message)
      continue
    }
    const content = message.content.filter(
      (block) => !isThinkingBlock(block) || isVerifiable(block),
    )
    if (content.length === message.content.length) {
      messages.push(message)
      continue
    }
    changed = true
    if (content.length > 0) messages.push({ ...message, content })
  }
  return changed ? { ...payload, messages } : payload
}

function isVerifiable(block: ThinkingBlock): boolean {
  const signature = signatureOf(block)
  if (!signature) return false
  return !rejectedSignatures.has(fingerprintSignature(signature))
}

function* thinkingBlocks(
  messages: Array<AnthropicMessage>,
): Generator<ThinkingBlock> {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }
    for (const block of message.content) {
      if (isThinkingBlock(block)) yield block
    }
  }
}

// redacted_thinking is not in the local types, but clients send it back.
function isThinkingBlock(block: { type: string }): block is ThinkingBlock {
  return block.type === "thinking" || block.type === "redacted_thinking"
}

function signatureOf(block: ThinkingBlock): string | undefined {
  return block.type === "thinking" ? block.signature : block.data
}

function fingerprintSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("base64")
}
