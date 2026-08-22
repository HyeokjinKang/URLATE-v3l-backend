// Filters nicknames that are well-formed but unusable (a stage after isValidNickname passes).
//
// The two lists use different matching rules.
//   RESERVED  — blocked only on an exact match after normalization. For names
//               that are a problem by themselves, like impersonation or
//               reserved words. Blocking on substring would catch a legitimate
//               name like badminton on admin.
//   PROFANITY — blocked if it appears anywhere in the normalized string.
//               Profanity can be evaded by padding either side (shibal123,
//               xxfuckxx), so exact match is pointless here.
//
// PROFANITY only holds words of 4+ characters that rarely appear inside other
// words. Shorter fragments like ass or cum would also catch classic or document.
// False positives still slip through (e.g. shiitake); before adding an entry,
// check that the string doesn't sit inside an ordinary word.

/**
 * Normalizes a name before comparison: lowercases it and reverses separators
 * and common leet substitutions, so adm1n, _admin_ and a-d-m-i-n all collapse
 * to admin.
 *
 * Normalization can shorten a string (n_u_l_l -> null), so the lists must
 * include entries under 5 characters too -- independent of the nickname's own
 * length limit.
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

// Blocked only on an exact match against the normalized form.
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

// Blocked if it appears anywhere in the normalized string.
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

/**
 * Ordinary strings that happen to contain a PROFANITY entry; stripped out before
 * the check runs.
 *
 * Substring matching has no notion of syllable boundaries, so shi + ta/to --
 * common in romanized Japanese and Korean -- reads as shit (ashita, yoshito,
 * ishita, shiitake, ...). Stripping these here lets those names through, at the
 * cost of also letting through a deliberate evasion like shitaaa. The filter is
 * a courtesy, not a security control, so letting a legitimate name through beats
 * blocking one by mistake.
 *
 * Most false-positive reports can be fixed by adding one line here.
 */
const ALLOWED = ["shita", "shito"].map(normalize);

/**
 * True if the nickname is unusable. Not applied to users who already signed up
 * (there's no rename path, so this only needs to run at signup).
 */
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
