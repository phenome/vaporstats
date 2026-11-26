export const ENROLLMENT_START_DATE_KEY = "media:enrollment-start-date";

export function isNewReleaseDate(releasedOn: string | null, enrollmentStartDate: string, day: string): boolean {
  return releasedOn !== null && releasedOn >= enrollmentStartDate && releasedOn <= day;
}
