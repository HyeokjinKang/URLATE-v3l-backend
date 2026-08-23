// Filters nicknames that are well-formed but unusable (runs after isValidNickname).
//
//   RESERVED  — exact match only. Substring would catch badminton on admin.
//   PROFANITY — substring, since padding evades exact match (shibal123, xxfuckxx).
//
// PROFANITY holds only 4+ character words that rarely appear inside others;
// shorter fragments like ass or cum would catch classic or document. Before
// adding an entry, check it doesn't sit inside an ordinary word.

// Lowercases and reverses separators and leet substitutions, so adm1n, _admin_
// and a-d-m-i-n all collapse to admin. This can shorten a string (n_u_l_l ->
// null), so the lists need entries under 5 characters too.
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
    // What a missing or invalid value serializes to
    "undefined",
    "null",
    "nan",
    "infinity",
    "true",
    "false",
    "object",
    "nickname",
    // Impersonating the people who run the service
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
    // Names that refer to no one in particular
    "anonymous",
    "guest",
    "everyone",
    "unknown",
    "deleted",
    "bot",
    // Too short for the substring list, so blocked here on exact match only.
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
  // English
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
  // Korean, romanized
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

// Ordinary strings containing a PROFANITY entry, stripped before the check.
// Substring matching ignores syllable boundaries, so shi + ta/to (common in
// romanized Japanese and Korean) reads as shit: ashita, yoshito, shiitake.
// This also lets through a deliberate shitaaa, but the filter is a courtesy
// rather than a security control. Most false positives are one line here.
const ALLOWED = ["shita", "shito"].map(normalize);

export const isBlockedNickname = (nickname: string): boolean => {
  const normalized = normalize(nickname);
  if (RESERVED.has(normalized)) return true;
  // Replace a stripped span with a space; joining directly could form a new word.
  const scanned = ALLOWED.reduce(
    (acc, safe) => acc.split(safe).join(" "),
    normalized,
  );
  return PROFANITY.some((word) => scanned.includes(word));
};
