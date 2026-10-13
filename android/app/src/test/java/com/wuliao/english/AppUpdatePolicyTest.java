package com.wuliao.english;
import org.junit.Test;
import static org.junit.Assert.*;
import java.net.URL;

public class AppUpdatePolicyTest {
    private final String sha = "a".repeat(64);
    private void candidate(String pkg, long code, int min, String flavor, String hash) {
        AppUpdatePolicy.candidate(pkg, "com.wuliao.english", code, 91, min, 31, flavor, 100, hash);
    }
    @Test public void validFullUpdate() { candidate("com.wuliao.english", 93, 24, "full", sha); }
    @Test public void rejectsWrongPackageDowngradeFlavorCorruptAndUnsupportedSdk() {
        assertThrows(IllegalArgumentException.class, () -> candidate("another.app", 93, 24, "full", sha));
        assertThrows(IllegalArgumentException.class, () -> candidate("com.wuliao.english", 91, 24, "full", sha));
        assertThrows(IllegalArgumentException.class, () -> candidate("com.wuliao.english", 90, 24, "full", sha));
        assertThrows(IllegalArgumentException.class, () -> candidate("com.wuliao.english", 93, 24, "tools-only", sha));
        assertThrows(IllegalArgumentException.class, () -> candidate("com.wuliao.english", 93, 24, "full", "broken"));
        assertThrows(IllegalArgumentException.class, () -> candidate("com.wuliao.english", 93, 32, "full", sha));
    }
    @Test public void rejectsDifferentMissingAndMultipleSigners() {
        AppUpdatePolicy.signing(sha, sha, 1);
        assertThrows(IllegalArgumentException.class, () -> AppUpdatePolicy.signing(sha, "other", 1));
        assertThrows(IllegalArgumentException.class, () -> AppUpdatePolicy.signing(null, null, 1));
        assertThrows(IllegalArgumentException.class, () -> AppUpdatePolicy.signing(sha, sha, 2));
    }
    @Test public void rejectsUntrustedSources() throws Exception {
        assertTrue(AppUpdatePolicy.allowed(new URL(AppUpdatePolicy.LATEST)));
        assertTrue(AppUpdatePolicy.releaseAsset(new URL("https://github.com/" + AppUpdatePolicy.REPOSITORY + "/releases/download/v1/a.apk")));
        for (String address : new String[] {"http://github.com/" + AppUpdatePolicy.REPOSITORY + "/releases/download/v1/a.apk", "https://github.com/other/repo/releases/download/v1/a.apk", "https://github.com.evil.com/file", "https://user:password@github.com/" + AppUpdatePolicy.REPOSITORY + "/releases/download/v1/a.apk", "https://api.github.com/repos/other/repo/releases/latest", "https://github.com:444/" + AppUpdatePolicy.REPOSITORY + "/releases/download/v1/a.apk"}) assertFalse(address, AppUpdatePolicy.allowed(new URL(address)));
    }
}
