import { expect, test } from "bun:test";
import { presentMediaFindingText } from "../src/lib/media-finding-presentation";

test.each([
  ["Combat feels fluid and enjoyable on PC (reviewed PC version)", "Combat feels fluid and enjoyable"],
  ["Visual scenes look striking and lively on PC with the 50GB Day 0 patch.", "Visual scenes look striking and lively."],
  ["Optional quests are only available on PC (reviewed PC version)", "Optional quests are only available on PC"],
  ["Animation glitches interrupt dramatic scenes on PC (reviewed PC version)",
    "Animation glitches interrupted dramatic scenes"],
  ["Optional quests can influence the ending on PC (reviewed PC version)",
    "Optional quests can influence the ending"],
  ["Enemy AI is rote and lacks tactical challenge (50GB Day 0 patch, PC)",
    "Enemy AI is rote and lacks tactical challenge"],
  ["Vehicles can spawn inside each other on PC (PC, Day 0 patch).",
    "Vehicles can spawn inside each other on PC with the Day 0 patch."],
  ["Vehicles can spawn inside each other (Day 0 patch)",
    "Vehicles can spawn inside each other with the Day 0 patch"],
  ["On the 50GB Day 0 patch PC build, textures could load late.",
    "On PC with the 50GB Day 0 patch, textures could load late."],
  ["On Switch 2, neon glows are less crisp than on PC, PS5, or Xbox Series X (On the Switch 2 port)",
    "On Switch 2, neon glows are less crisp than on PC, PS5, or Xbox Series X"],
  ["Docked output reaches 1080p (On the Switch 2 port).",
    "Docked output reaches 1080p on the Switch 2 port."],
  ["Docked output reaches 1080p on Switch 2 (Switch 2 version).",
    "Docked output reaches 1080p on Switch 2."],
  ["Arachne offers a choice of dresses (Early Access).",
    "Arachne offers a choice of dresses in Early Access."],
  ["In Early Access, initiative order matters (Early Access).",
    "In Early Access, initiative order matters."],
  ["Resources unlock new weapons in the Early Access build (Early Access).",
    "Resources unlock new weapons in the Early Access build."],
])("presents the saved wording %s", (saved, expected) => {
  expect(presentMediaFindingText(saved, 1091500)).toBe(expected);
});

test.each([
  "The press version contained bugs (Early Access, weekend press build)",
  "The game runs at 40fps (Switch 2, prototype build)",
  "The builds allow flexible experimentation (PC 1.0)",
  "The Early Access version includes six classes (Fighter, Wizard, Cleric, Rogue, Ranger, and Warlock).",
  "Textures could load late (Day 0 patch, PC) / Neon stands out (Switch 2)",
  "The update fixed broken quests on PC with the 50GB Day 0 patch.",
])("preserves unfamiliar or already natural wording %s", (saved) => {
  expect(presentMediaFindingText(saved)).toBe(saved);
});

test("a reviewed legacy wording correction stays with its game", () => {
  expect(presentMediaFindingText("Combat feels fluid and enjoyable on PC (reviewed PC version)", 42)).toBe("Combat feels fluid and enjoyable on PC");
});
