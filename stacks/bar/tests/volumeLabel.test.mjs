// volumeLabel — the volume item's text. Built-in speakers stay unnamed;
// any other output device is named, without the owner's possessive.
import test from "node:test";
import assert from "node:assert/strict";
import { volumeLabel } from "../logic.js";

test("built-in output shows only the level", () => {
  assert.equal(volumeLabel({ deviceName: "MacBook Pro Speakers", volume: 0.5, muted: false }, "Built-in"),
    "{sf:speaker.wave.2.fill} 50%");
});

test("an external device is named without the possessive", () => {
  assert.equal(volumeLabel({ deviceName: "Mateo's AirPods Max", volume: 0.25, muted: false }, "Bluetooth"),
    "{sf:speaker.wave.2.fill} AirPods Max 25%");
});

test("a device whose transport is not known yet stays unnamed", () => {
  assert.equal(volumeLabel({ deviceName: "Mateo's AirPods Max", volume: 0.25, muted: false }, undefined),
    "{sf:speaker.wave.2.fill} 25%");
});

test("muted output says so", () => {
  assert.equal(volumeLabel({ deviceName: "Mateo's AirPods Max", volume: 0.25, muted: true }, "Bluetooth"),
    "{sf:speaker.slash.fill} AirPods Max muted");
});

test("an output without a volume control shows just the icon", () => {
  assert.equal(volumeLabel({ deviceName: "HDMI", volume: null, muted: false }, "HDMI"), "{sf:speaker.wave.2.fill} HDMI");
});

test("no output shows nothing", () => {
  assert.equal(volumeLabel(null, undefined), "");
});
