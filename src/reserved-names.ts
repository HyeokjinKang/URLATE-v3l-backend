// 가입 시 선점을 막을 닉네임 목록입니다.
//
// 형식 검증(isValidNickname)만으로는 막을 수 없는 두 부류를 다룹니다.
//   1. 직렬화 산출물 — displayName을 빼먹으면 "undefined"가 되던 것처럼,
//      값이 없거나 잘못된 상태를 그대로 문자열로 만든 이름들입니다. 실제
//      사용자와 구분이 되지 않아 로그와 화면을 모두 헷갈리게 만듭니다.
//   2. 운영 주체를 사칭하는 이름 — admin, staff, urlate 등.

/**
 * 비교 전에 이름을 정규화합니다. 소문자로 낮추고, 구분자와 흔한 leet 치환을
 * 되돌립니다. adm1n, _admin_, a-d-m-i-n이 모두 admin으로 모입니다.
 *
 * 정규화가 길이를 줄일 수 있으므로(n_u_l_l → null) 목록에는 5자 미만도
 * 포함해야 합니다. 닉네임 자체의 길이 제한과는 별개입니다.
 */
const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[_-]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t");

// 정규화한 형태로 저장합니다(normalize를 거친 값과 정확히 일치할 때만 막습니다).
// 부분 문자열로 막으면 badminton처럼 정상적인 이름이 걸립니다.
const RESERVED = new Set(
  [
    // 값이 없거나 잘못된 상태의 직렬화 결과
    "undefined",
    "null",
    "nan",
    "infinity",
    "true",
    "false",
    "object",
    "nickname",
    // 운영 주체 사칭
    "admin",
    "administrator",
    "root",
    "system",
    "staff",
    "support",
    "helpdesk",
    "moderator",
    "mod",
    "operator",
    "owner",
    "official",
    "security",
    "urlate",
    "coupy",
    // 특정인이 아닌 대상을 가리키는 이름
    "anonymous",
    "guest",
    "everyone",
    "unknown",
    "deleted",
    "bot",
  ].map(normalize),
);

/**
 * 예약된 이름이면 true입니다. 이미 가입한 사용자에게는 적용하지 않습니다
 * (닉네임을 바꾸는 경로가 없어 가입 시점에만 판단하면 됩니다).
 */
export const isReservedNickname = (nickname: string): boolean =>
  RESERVED.has(normalize(nickname));
