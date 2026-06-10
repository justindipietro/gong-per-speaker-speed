// Shared speaker-name normalization. Loaded by both the content script and
// the popup so storage keys always match. Zero-width characters are stripped
// explicitly because \s does not match them; \s+ already covers NBSP and the
// rest of the Unicode space family.
function normName(name) {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
