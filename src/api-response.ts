interface ResponseBase {
  result: string;
}

// A success response carries only result, so this is a type alias rather
// than an empty interface extends (which lint flags as identical to its
// parent type).
export type SuccessResponse = ResponseBase;

export interface ErrorResponse extends ResponseBase {
  error: string;
  description: string;
}

export interface StatusResponse {
  status: string;
}

export type ApiResponse = SuccessResponse | ErrorResponse | StatusResponse;

export function createSuccessResponse(result: string): SuccessResponse {
  return { result };
}

export function createErrorResponse(
  result: string,
  error: string,
  description: string,
): ErrorResponse {
  return { result, error, description };
}

export function createStatusResponse(status: string): StatusResponse {
  return { status };
}
