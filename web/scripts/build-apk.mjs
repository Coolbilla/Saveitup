// Builds web assets, syncs them into the Android project and produces a debug APK.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const sdk = process.env.ANDROID_HOME || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"));
const jbr = process.env.JAVA_HOME_ANDROID || "C:/Program Files/Android/Android Studio/jbr";
const env = { ...process.env, ANDROID_HOME: sdk, ...(existsSync(jbr) ? { JAVA_HOME: jbr } : {}) };
const run = (cmd, args, cwd = ".") => {
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("npm", ["run", "android:sync"]);
const gradlew = resolve("android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
run(`"${gradlew}"`, ["assembleDebug"], "android");
console.log("\nAPK: android/app/build/outputs/apk/debug/app-debug.apk");
