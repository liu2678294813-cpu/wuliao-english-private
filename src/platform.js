import { Capacitor } from "@capacitor/core";

export function isAndroidApp() {
  return Capacitor.getPlatform() === "android";
}

