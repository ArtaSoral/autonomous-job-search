import { Bank } from "./bank";
export function careerTenure(bank: Bank, at = new Date()) {
  const intervals = bank.experience
    .map((r) => {
      const start = new Date(
        Date.UTC(
          Number(r.start_year),
          Number(r.start_month) - 1,
          Number(r.start_day) || 1,
        ),
      ).getTime();
      const end = r.is_current
        ? at.getTime()
        : new Date(
            Date.UTC(
              Number(r.end_year),
              Number(r.end_month) - 1,
              Number(r.end_day) || 1,
            ),
          ).getTime();
      return { start, end: Math.min(end, at.getTime()) };
    })
    .filter(
      (r) =>
        Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start,
    )
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end)
      previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return {
    years:
      merged.reduce((n, i) => n + i.end - i.start, 0) / (365.25 * 86400000),
    as_of: at.toISOString().slice(0, 10),
    source_ids: bank.experience.map((r) => r.id),
  };
}
