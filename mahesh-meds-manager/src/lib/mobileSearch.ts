/**
 * What a "token or mobile number" search box holds: the 10-digit mobile number, "" for a number that is not a
 * valid Indian mobile, or null for anything else (treated as a token). Accepts +91, 91 and 0 prefixes, spaces
 * and dashes, like the server's lookup.
 */
export function mobileFromSearch(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[+\d\s()-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? digits : "";
}
