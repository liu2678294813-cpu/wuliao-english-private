package com.wuliao.english;

import java.net.URL;

/** Release identity rules, independent of Android so negative cases are testable. */
public final class AppUpdatePolicy {
    public static final String REPOSITORY = "liu2678294813-cpu/wuliao-english-private";
    public static final String LATEST = "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";

    public static boolean releaseAsset(URL url) {
        return "https".equals(url.getProtocol()) && url.getUserInfo() == null
            && (url.getPort() == -1 || url.getPort() == 443)
            && "github.com".equals(url.getHost())
            && url.getPath().startsWith("/" + REPOSITORY + "/releases/download/");
    }

    public static boolean allowed(URL url) {
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null
            || (url.getPort() != -1 && url.getPort() != 443)) return false;
        String host = url.getHost();
        return releaseAsset(url)
            || ("api.github.com".equals(host) && url.getPath().startsWith("/repos/" + REPOSITORY + "/releases/"))
            || "release-assets.githubusercontent.com".equals(host)
            || "objects.githubusercontent.com".equals(host);
    }

    public static void candidate(String actualPackage, String expectedPackage, long code, long installed,
        int minSdk, int sdk, String variant, long bytes, String sha) {
        if (!expectedPackage.equals(actualPackage)) throw new IllegalArgumentException("安装包包名与当前应用不一致");
        if (code <= installed) throw new IllegalArgumentException("仅允许更新到更高版本");
        if (minSdk < 24 || minSdk > sdk) throw new IllegalArgumentException("此版本不支持当前 Android 系统");
        if (!"full".equals(variant)) throw new IllegalArgumentException("此发布不是含文章统一版本");
        if (bytes <= 0 || sha == null || !sha.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("发布校验信息不完整");
    }

    public static void signing(String installed, String archive, int signers) {
        if (signers != 1 || installed == null || !installed.equals(archive))
            throw new IllegalArgumentException("安装包签名与当前应用不一致，已停止更新");
    }

    private AppUpdatePolicy() {}
}
