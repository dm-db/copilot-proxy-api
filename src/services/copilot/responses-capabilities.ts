import type { ResponsesApiRequest } from "~/routes/responses/types"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export function validateResponsesCapabilities(
  payload: ResponsesApiRequest,
): void {
  const efforts = state.models?.data.find((model) => model.id === payload.model)
    ?.capabilities.supports.reasoning_effort
  if (
    payload.reasoning?.effort
    && efforts?.length
    && !efforts.includes(payload.reasoning.effort)
  ) {
    throw new HTTPError(
      "Unsupported reasoning effort",
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: "unsupported_parameter",
            param: "reasoning.effort",
            message: `Model ${payload.model} supports reasoning effort: ${efforts.join(", ")}`,
          },
        },
        { status: 400 },
      ),
    )
  }
}
