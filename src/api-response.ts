interface ResponseBase {
  result: string;
}

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
