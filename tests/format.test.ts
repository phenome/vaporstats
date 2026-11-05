import { expect, test } from "bun:test";

interface DateFormats {
  calendarDates: string[];
  instant: string;
  sqliteInstant: string;
  dateObject: string;
}

function formatsInZone(timeZone: string): DateFormats {
  const formatterUrl = new URL("../src/lib/format.ts", import.meta.url).href;
  const result = Bun.spawnSync([process.execPath, "-e", `
    import { formatDateOnly } from ${JSON.stringify(formatterUrl)};
    console.log(JSON.stringify({
      calendarDates: ["2025-09-17", "2026-09-16", "2024-02-29"].map(value => formatDateOnly(value)),
      instant: formatDateOnly("2025-09-17T00:00:00Z"),
      sqliteInstant: formatDateOnly("2025-09-17 00:00:00"),
      dateObject: formatDateOnly(new Date("2025-09-17T00:00:00Z")),
    }));
  `], { env: { ...process.env, TZ: timeZone } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString()) as DateFormats;
}

test("calendar dates keep their day across zones without freezing observation instants to UTC", () => {
  const utc = formatsInZone("UTC");
  const losAngeles = formatsInZone("America/Los_Angeles");
  expect(losAngeles.calendarDates).toEqual(utc.calendarDates);
  expect(losAngeles.instant).not.toBe(utc.instant);
  expect(utc.instant).toBe(utc.calendarDates[0]);
  expect(losAngeles.instant).not.toBe(losAngeles.calendarDates[0]);
  for (const formats of [utc, losAngeles]) {
    expect(formats.sqliteInstant).toBe(formats.instant);
    expect(formats.dateObject).toBe(formats.instant);
  }
});
