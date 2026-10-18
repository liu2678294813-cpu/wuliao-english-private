import test from "node:test";
import assert from "node:assert/strict";
import { isPhoneDevice } from "../src/inputDevicePolicy.js";

for (const [label, userAgent, expected] of [
  ["Android phone WebView", "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A; wv) AppleWebKit/537.36 Version/4.0 Chrome/132.0 Mobile Safari/537.36", true],
  ["Android tablet WebView", "Mozilla/5.0 (Linux; Android 12; BTK-W00; wv) AppleWebKit/537.36 Version/4.0 Chrome/132.0 Safari/537.36", false],
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", true],
  ["iPad with Mobile in its UA", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", false],
  ["iPad desktop UA", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", false],
  ["desktop", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/132.0 Safari/537.36", false],
  ["HarmonyOS phone", "Mozilla/5.0 (HarmonyOS 5.0; Phone) AppleWebKit/537.36 Mobile Safari/537.36", true],
]) {
  test(`${label}: device input policy`, () => assert.equal(isPhoneDevice({ userAgent }), expected));
}

test("user agent metadata identifies a phone without viewport assumptions", () => {
  assert.equal(isPhoneDevice({ userAgent: "reduced", userAgentData: { mobile: true } }), true);
  assert.equal(isPhoneDevice({ userAgent: "reduced", userAgentData: { mobile: false } }), false);
});

test("rotating a phone or narrowing a tablet leaves its input policy unchanged", () => {
  const phone = { userAgent: "Android Mobile" };
  const tablet = { userAgent: "Android Tablet" };
  for (const width of [320, 390, 544, 760, 844, 1280]) {
    assert.equal(isPhoneDevice({ ...phone, innerWidth: width }), true);
    assert.equal(isPhoneDevice({ ...tablet, innerWidth: width }), false);
  }
});

test("missing device metadata preserves desktop input", () => {
  assert.equal(isPhoneDevice(null), false);
  assert.equal(isPhoneDevice({}), false);
});
