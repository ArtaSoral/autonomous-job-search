export const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|corporation|corp)\b/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
