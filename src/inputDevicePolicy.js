// Input capability follows the device, so rotating a phone or narrowing a
// tablet window cannot switch the user's input mode or move existing ink.
export function isPhoneDevice(deviceNavigator = globalThis.navigator) {
  if (!deviceNavigator) return false;
  const userAgent = String(deviceNavigator.userAgent || "");
  if (/\b(iPad|Tablet|PlayBook)\b/i.test(userAgent)) return false;
  if (typeof deviceNavigator.userAgentData?.mobile === "boolean") {
    return deviceNavigator.userAgentData.mobile;
  }
  return /\b(iPhone|iPod|IEMobile|Windows Phone|Opera Mini)\b|(?:Android|HarmonyOS).*\bMobile\b/i.test(userAgent);
}
