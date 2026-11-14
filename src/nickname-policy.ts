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

const RESERVED = new Set(
  [
    "undefined",
    "null",
    "nan",
    "infinity",
    "true",
    "false",
    "object",
    "nickname",
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
    "anonymous",
    "guest",
    "everyone",
    "unknown",
    "deleted",
    "bot",
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

const PROFANITY = [
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

const ALLOWED = ["shita", "shito"].map(normalize);

export const isBlockedNickname = (nickname: string): boolean => {
  const normalized = normalize(nickname);
  if (RESERVED.has(normalized)) return true;
  const scanned = ALLOWED.reduce(
    (acc, safe) => acc.split(safe).join(" "),
    normalized,
  );
  return PROFANITY.some((word) => scanned.includes(word));
};
