// 형식은 맞지만 쓸 수 없는 닉네임을 걸러 냅니다(isValidNickname 통과 이후 단계).
//
// 두 목록을 매칭 방식으로 나눠 씁니다.
//   RESERVED  — 정규화 후 "완전 일치"할 때만 차단. 사칭·예약어처럼 그 이름
//               자체가 문제인 경우입니다. 부분 일치로 막으면 badminton 같은
//               정상적인 이름이 admin에 걸립니다.
//   PROFANITY — 정규화 후 "포함"되면 차단. 욕설은 앞뒤에 아무 글자나 붙여
//               피할 수 있어(shibal123, xxfuckxx) 완전 일치로는 의미가 없습니다.
//
// PROFANITY에는 다른 단어의 일부로 잘 나타나지 않는 4자 이상만 넣습니다.
// ass, cum 같은 짧은 조각을 넣으면 classic·document가 함께 걸립니다.
// 그럼에도 오탐은 남습니다(예: shiitake). 새 항목을 넣을 때는 그 문자열이
// 멀쩡한 단어 안에 들어가지 않는지 먼저 확인하세요.

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

// 정규화한 형태와 정확히 일치할 때만 차단합니다.
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
    // 짧아서 부분 일치로 넣을 수 없는 욕설은 여기서 완전 일치로만 막습니다.
    "ass",
    "cum",
    "fag",
    "dick",
    "cock",
    "rape",
    "nazi",
    "jaji",
    "boji",
  ].map(normalize),
);

// 정규화한 문자열 어디에든 들어 있으면 차단합니다.
const PROFANITY = [
  // 영어
  "fuck",
  "shit",
  "bitch",
  "bastard",
  "asshole",
  "cunt",
  "whore",
  "slut",
  "pussy",
  "wanker",
  "dickhead",
  "faggot",
  "nigger",
  "nigga",
  "retard",
  "cocksuck",
  "motherfuck",
  // 한국어 로마자 표기
  "sibal",
  "shibal",
  "ssibal",
  "sibar",
  "shibar",
  "ssibar",
  "sipal",
  "shipal",
  "jotgat",
  "jotna",
  "jotmat",
  "byungsin",
  "byeongsin",
  "gaesaekki",
  "gaesekki",
  "gaesaeki",
  "gaeseki",
  "saekki",
  "jiral",
].map(normalize);

/**
 * PROFANITY 항목을 품고 있지만 멀쩡한 문자열입니다. 검사 전에 지워 둡니다.
 *
 * 부분 일치는 음절 경계를 모르기 때문에, 일본어·한국어 로마자에서 자주 나오는
 * shi + ta/to가 shit으로 읽힙니다(ashita, yoshito, ishita, shiitake …).
 * 여기서 지우면 그 이름들이 통과합니다. 대신 shitaaa처럼 뒤에 모음을 붙인
 * 회피는 함께 통과합니다. 욕설 필터는 예의 장치이지 보안 통제가 아니므로,
 * 작정한 회피를 막는 것보다 멀쩡한 이름을 막지 않는 쪽을 택했습니다.
 *
 * 오탐 신고가 들어오면 대부분 여기에 한 줄 추가하면 됩니다.
 */
const ALLOWED = ["shita", "shito"].map(normalize);

/**
 * 쓸 수 없는 닉네임이면 true입니다. 이미 가입한 사용자에게는 적용하지 않습니다
 * (닉네임을 바꾸는 경로가 없어 가입 시점에만 판단하면 됩니다).
 */
export const isBlockedNickname = (nickname: string): boolean => {
  const normalized = normalize(nickname);
  if (RESERVED.has(normalized)) return true;
  // 지운 자리는 공백으로 채웁니다. 그냥 이으면 없던 단어가 생길 수 있습니다.
  const scanned = ALLOWED.reduce(
    (acc, safe) => acc.split(safe).join(" "),
    normalized,
  );
  return PROFANITY.some((word) => scanned.includes(word));
};
