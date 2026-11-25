import { expect, test } from "bun:test";
import { legacyObservationEvidence } from "../src/lib/media-legacy-observations";

test("saved findings retain their own scope and source-wide traits stay out of ordinary discovery", () => {
  const extraction = {
    contributions: [
      { text: "The Early Access version offers six classes.", category: "Gameplay & systems" },
      { text: "A roll resolves improvised actions.", category: "Gameplay & systems" },
    ],
    qualifications: ["Played over a weekend", "No platform specified"],
    traits: ["Single-player", "Early Access build"],
  };
  const { observations, editorialOmissions } = legacyObservationEvidence(extraction, 1086940, "Early Access");
  expect(observations.map(({ text, qualifiers }) => [text, qualifiers])).toEqual([
    [extraction.contributions[0]!.text, []], [extraction.contributions[1]!.text, ["Early Access"]],
  ]);
  expect(editorialOmissions.map(({ wording }) => wording)).toEqual(extraction.traits);
  const unknown = legacyObservationEvidence(extraction, 1086940);
  expect(unknown.editorialOmissions[0]?.observationId).toBe("legacy-2");
});

test("a Switch 2 observation can stand independently of unrelated whole-article qualifications", () => {
  const text = "On the Switch 2 port, aiming uses the Joy-Con.";
  const evidence = legacyObservationEvidence({ contributions: [{ text, category: "Gameplay & systems" }],
    qualifications: ["An assessment over a few days", "Performance details vary by mode"] }, 1091500);
  expect(evidence.observations[0]?.text).toBe(text);
});

test("a separately recorded Day 0 patch qualifies the saved bug report", () => {
  const row = { contributions: [{ text: "Vehicles spawn inside one another.", category: "Technical experience & accessibility" }],
    qualifications: ["PC platform", "50GB Day 0 patch"] };
  expect(legacyObservationEvidence(row, 1091500).observations[0]?.qualifiers).toEqual(["50GB Day 0 patch", "PC"]);
  expect(legacyObservationEvidence({ ...row, qualifications: ["The launch day was December 10"] }, 1091500).observations).toBeEmpty();
});

test("legacy hardware traits retain an explicit corroborated platform", () => {
  const row = { traits: ["Supports Joy-Con aiming on Switch 2", "Offers motion gestures"],
    qualifications: ["The assessment covers the Switch 2 port."] };
  const result = legacyObservationEvidence(row, 1091500);
  expect(result.observations.map(o => o.text)).toEqual([row.traits[0]!]);
  expect(result.editorialOmissions.map(o => o.wording)).toEqual([row.traits[1]!]);
});
