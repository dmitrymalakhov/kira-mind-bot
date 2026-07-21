const STRONG_LEGACY_PATTERNS = [
  /сны данных/iu,
  /лицей контекста/iu,
  /хранительниц[аы] малых архивов/iu,
  /учебные залы/iu,
  /город потоков/iu,
];

function hasLegacyDigitalBiography(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;

  return STRONG_LEGACY_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = {
  hasLegacyDigitalBiography,
};
