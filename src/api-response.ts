interface ResponseBase {
  result: string;
}

// 성공 응답은 result만 담습니다. 별도 필드가 없으므로 별칭으로 둡니다.
// (빈 interface extends는 상위 타입과 동일해 lint 오류가 납니다.)
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
