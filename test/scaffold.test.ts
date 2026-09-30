import { describe, expect, it } from "vitest";
import { fixtureBytes } from "./helpers.js";

describe("fixtures", () => {
  it.each([
    "01-basic-formatting.sdocx",
    "02-shapes-and-dot-calibration.sdocx",
    "03-image-placement.sdocx",
    "04-marker4-highlighter.sdocx",
  ])("%s is a zip archive", (name) => {
    expect([...fixtureBytes(name).slice(0, 2)]).toEqual([0x50, 0x4b]);
  });
});
