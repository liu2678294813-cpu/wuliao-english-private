package com.wuliao.english;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;

/** Only updater-owned files may be removed. No WebView or learning storage paths. */
public final class UpdateFiles {
    public interface Verifier { boolean verified(File directory) throws Exception; }

    public static void delete(File root, File file) throws IOException {
        File canonicalRoot = root.getCanonicalFile();
        File canonicalFile = file.getCanonicalFile();
        if (!canonicalFile.getPath().startsWith(canonicalRoot.getPath() + File.separator))
            throw new IOException("更新文件清理路径无效");
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("无法读取更新文件目录");
            for (File child : children) delete(root, child);
        }
        if (!file.delete()) throw new IOException("无法清理更新文件，请重试");
    }

    public static void clearDownloads(File cacheRoot) throws IOException {
        File directory = new File(cacheRoot, "updates");
        if (!directory.exists()) return;
        // These are the only names used by both the old and current updater.
        delete(cacheRoot, new File(directory, "update.apk.part"));
        delete(cacheRoot, new File(directory, "update.apk"));
    }

    public static File pruneBackups(File root, File activeCandidate, Verifier verifier) throws Exception {
        File[] directories = root.listFiles(file -> file.isDirectory()
            && file.getName().matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
            && !file.equals(activeCandidate));
        if (directories == null) return null;
        Arrays.sort(directories, Comparator.comparingLong((File file) -> new File(file, "verified.json").lastModified()).reversed());
        File keep = null;
        for (File directory : directories) {
            if (!directory.getCanonicalFile().getParentFile().equals(root.getCanonicalFile()))
                throw new IOException("更新备份清理路径无效");
            if (verifier.verified(directory)) { keep = directory; break; }
        }
        for (File directory : directories) {
            // Without a verified successor, preserve completed recovery material.
            if (!directory.equals(keep) && (keep != null || !new File(directory, "verified.json").exists()))
                delete(root, directory);
        }
        return keep;
    }

    public static long bytes(File file) throws IOException {
        if (!file.exists()) return 0;
        if (!file.isDirectory()) return file.length();
        long bytes = 0;
        File[] children = file.listFiles();
        if (children == null) throw new IOException("无法读取更新目录");
        for (File child : children) {
            if (!child.getCanonicalFile().getParentFile().equals(file.getCanonicalFile()))
                throw new IOException("更新目录路径无效");
            bytes = Math.addExact(bytes, bytes(child));
        }
        return bytes;
    }
}
