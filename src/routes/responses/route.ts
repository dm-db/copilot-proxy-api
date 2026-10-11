import consola from "consola"
import { Hono } from "hono"

import { forwardError, HTTPError } from "~/lib/error"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    if (error instanceof HTTPError) {
      const errorText = await error.response.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(errorText)
      } catch {
        parsed = errorText
      }
      consola.error("Responses HTTP error body:", parsed)
      if (
        /codex/i.test(c.req.header("user-agent") ?? "")
        && typeof parsed === "object"
        && parsed !== null
        && "error" in parsed
        && typeof parsed.error === "object"
        && parsed.error !== null
        && "code" in parsed.error
        && parsed.error.code === "context_length_exceeded"
      ) {
        // Codex recognizes context overflow in SSE, but treats HTTP 400 as
        // a generic unexpected status. Give its compaction loop the typed event.
        const event = {
          type: "response.failed",
          sequence_number: 0,
          response: {
            id: "resp_context_overflow",
            status: "failed",
            error: parsed.error,
            output: [],
          },
        }
        return new Response(
          `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`,
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          },
        )
      }

      return new Response(errorText, {
        status: error.response.status,
        statusText: error.response.statusText,
        headers: {
          "content-type":
            error.response.headers.get("content-type") ?? "application/json",
        },
      })
    }

    return await forwardError(c, error)
  }
})
