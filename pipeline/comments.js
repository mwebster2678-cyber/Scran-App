// Which YouTube comments are worth reading: only ones that say what or where a place is
// ("this is Shawarma Hut", "It's called…", "Restaurant - SAEL", an address, postcode or 📍),
// not every comment mentioning food. Used by verify.js (for Claude) and the review page.
const SAYS_WHERE = [
  /\b(?:[Tt]his is|[Tt]his place is|[Tt]he (?:place|restaurant|spot) is|[Ii]t'?s|[Ii]t is|(?:place |restaurant |it'?s |is )?[Cc]alled|[Nn]ame is|[Ll]ocated (?:at|in|on))\s*[-:]?\s*(?:@\s*)?(?:the |The )?(?!London\b)[A-Z][\w'’&.-]+/,
  /\b(?:Restaurant|Location|Address|Place)\s*[-:]\s*\S/i,
  /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/, // postcode
  /\b\d+[a-z]?\s+(?:[A-Z][\w'’]+\s+){1,3}(?:Street|St|Road|Rd|Lane|Ln|Avenue|Ave|Place|Pl|Square|Sq|Row|Hill|Market|Court|Way|Yard|Walk)\b/,
  /(?:^|\s)@\s?[A-Z][a-z]/,
];
export const saysWhere = text => text.includes('📍') || SAYS_WHERE.some(re => re.test(text));
