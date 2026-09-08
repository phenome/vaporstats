import { describe, expect, test } from "bun:test";
import {
  mapSteamAppDetailsFacets,
  mapSteamStoreBrowseTags,
  parseSteamTagDictionaryResponse,
} from "../src/lib/taxonomy";

describe("catalog taxonomy mapping", () => {
  test("keeps appdetails groups separate and preserves omitted groups", () => {
    const facets = mapSteamAppDetailsFacets({
      genres: [{ id: "1", description: "Action" }],
      categories: [],
    });

    expect(facets.genre).toMatchObject({
      status: "present",
      values: [{ facet_group: "genre", source_id: "1", name: "Action", source_order: 0 }],
    });
    expect(facets.feature).toEqual({ status: "present", values: [] });
    expect(mapSteamAppDetailsFacets({}).feature).toBeUndefined();
    expect(mapSteamAppDetailsFacets({ genres: [{ id: "not-an-id" }, { id: 0 }] }).genre).toBeUndefined();
    expect(mapSteamStoreBrowseTags([{ tagid: "unsafe-id" }])).toBeUndefined();
  });

  test("takes exactly the first twenty source tags before filtering", () => {
    const tags = Array.from({ length: 21 }, (_, index) => ({
      tagid: index + 1,
      name: index === 2 ? undefined : `Tag ${index + 1}`,
      weight: index + 10,
    }));
    const mapped = mapSteamStoreBrowseTags(tags);

    expect(mapped?.status).toBe("present");
    expect(mapped?.values).toHaveLength(20);
    expect(mapped?.values[0]).toMatchObject({ source_id: "1", source_order: 0, weight: 10 });
    expect(mapped?.values[2]).toMatchObject({ source_id: "3", source_order: 2, name: null, weight: 12 });
    expect(mapped?.values.at(-1)?.source_id).toBe("20");
    expect(mapped?.values.some((value) => value.source_id === "21")).toBe(false);
  });

  test("retains unknown tag IDs without inventing dictionary labels", () => {
    const mapped = mapSteamStoreBrowseTags([{ tagid: 999999, weight: 5 }]);
    const dictionary = parseSteamTagDictionaryResponse({ response: { tags: [{ tagid: 1, name: "Known" }] } });

    expect(mapped?.values).toEqual([
      {
        facet_group: "community_tag",
        source_id: "999999",
        name: null,
        source_order: 0,
        weight: 5,
      },
    ]);
    expect(dictionary).toEqual([{ facet_group: "community_tag", source_id: "1", name: "Known" }]);
  });
});
