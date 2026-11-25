interface SectionPosition {
  id: string;
  top: number;
  bottom: number;
}

interface FragmentPosition {
  sectionId: string;
  top: number;
  inset: number;
  scrollTop: number;
  maxScrollTop: number;
}

export function getActiveGameSection(
  sections: readonly SectionPosition[],
  navBottom: number,
  fragment?: FragmentPosition,
): string | undefined {
  if (fragment) {
    const { sectionId, top, inset, scrollTop, maxScrollTop } = fragment;
    const landing = Math.min(maxScrollTop, Math.max(0, scrollTop + top - inset));
    // The browser combines scroll padding and margin, then clamps and rounds the result.
    if (Math.abs(scrollTop - landing) <= 1) return sectionId;
  }

  const readingLine = navBottom + 20;
  let activeId = sections[0]?.id;
  for (const { id, top, bottom } of sections) {
    if (top <= readingLine) {
      if (bottom > readingLine) return id;
      activeId = id;
    }
  }
  return activeId;
}
