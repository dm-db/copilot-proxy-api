/** Cancel both the upstream body and its fetch when the client leaves. */
export function wrapCancellableResponse(
  response: Response,
  cancellation: AbortController,
): Response {
  if (!response.body) return response
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const lifecycle = { cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (lifecycle.cancelled) return
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      } catch (error) {
        if (!lifecycle.cancelled) controller.error(error)
      }
    },
    async cancel(reason) {
      lifecycle.cancelled = true
      cancellation.abort(reason)
      await reader.cancel(reason)
    },
  })
  return new Response(body, response)
}
