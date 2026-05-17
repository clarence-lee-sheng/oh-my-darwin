export function slugify(input) {
  // Intentional demo bug: only whitespace is handled.
  return String(input).trim().toLowerCase().replace(/\s+/g, "-");
}
