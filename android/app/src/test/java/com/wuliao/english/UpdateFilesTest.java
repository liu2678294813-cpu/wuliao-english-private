package com.wuliao.english;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.nio.file.Files;
import java.util.UUID;
import static org.junit.Assert.*;

public class UpdateFilesTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private File backup(File root, boolean verified, int sequence) throws Exception {
        File directory = new File(root, UUID.randomUUID().toString());
        assertTrue(directory.mkdirs());
        Files.write(new File(directory, "account-0.json").toPath(), ("learning-facts-" + sequence).getBytes());
        if (verified) {
            File receipt = new File(directory, "verified.json");
            Files.write(receipt.toPath(), "verified".getBytes());
            assertTrue(receipt.setLastModified(1000L * sequence));
        }
        return directory;
    }
    private boolean verified(File directory) { return new File(directory, "verified.json").isFile(); }

    @Test public void threeUpdatesKeepOneBackupAndZeroApksWithoutTouchingLearningFiles() throws Exception {
        File root = temporary.newFolder("update-backups"), cache = temporary.newFolder("cache");
        File learning = temporary.newFile("real-learning-database");
        Files.write(learning.toPath(), "original-data".getBytes());
        for (int round = 1; round <= 3; round++) {
            File fresh = backup(root, true, round);
            File downloads = new File(cache, "updates"); downloads.mkdirs();
            Files.write(new File(downloads, "update.apk").toPath(), new byte[4096]);
            Files.write(new File(downloads, "update.apk.part").toPath(), new byte[4096]);
            assertEquals(fresh, UpdateFiles.pruneBackups(root, null, this::verified));
            UpdateFiles.clearDownloads(cache);
            assertEquals(1, root.listFiles().length);
            assertEquals(0, downloads.listFiles().length);
            assertEquals("original-data", new String(Files.readAllBytes(learning.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        }
    }
    @Test public void incompleteCandidateCannotRemoveLastVerifiedBackup() throws Exception {
        File root = temporary.newFolder(); File original = backup(root, true, 1), candidate = backup(root, false, 2);
        UpdateFiles.pruneBackups(root, candidate, this::verified);
        assertTrue(original.exists()); assertTrue(candidate.exists());
        UpdateFiles.pruneBackups(root, null, this::verified);
        assertTrue(original.exists()); assertFalse(candidate.exists());
    }
    @Test public void corruptSuccessorIsNotPreferredAndCleanupIsIdempotent() throws Exception {
        File root = temporary.newFolder(); File original = backup(root, true, 1), corrupt = backup(root, true, 2);
        UpdateFiles.Verifier verifier = directory -> verified(directory) && !directory.equals(corrupt);
        assertEquals(original, UpdateFiles.pruneBackups(root, null, verifier));
        assertTrue(original.exists()); assertFalse(corrupt.exists());
        assertEquals(original, UpdateFiles.pruneBackups(root, null, verifier));
    }
    @Test public void cannotDeleteOutsideRootOrRootItself() throws Exception {
        File root = temporary.newFolder(), outside = temporary.newFile();
        assertThrows(java.io.IOException.class, () -> UpdateFiles.delete(root, outside));
        assertThrows(java.io.IOException.class, () -> UpdateFiles.delete(root, root));
        assertTrue(outside.exists()); assertTrue(root.exists());
    }
    @Test public void preservesUnrelatedExportsAndCacheFiles() throws Exception {
        File root = temporary.newFolder(), cache = temporary.newFolder();
        File exported = new File(root, "my-export"); assertTrue(exported.mkdirs());
        backup(root, true, 1); backup(root, true, 2);
        UpdateFiles.pruneBackups(root, null, this::verified);
        assertTrue(exported.exists());
        File downloads = new File(cache, "updates"); downloads.mkdirs();
        File other = new File(downloads, "user.pdf"); Files.write(other.toPath(), "user-document".getBytes());
        UpdateFiles.clearDownloads(cache); assertTrue(other.exists());
    }
    @Test public void preservesCompletedRecoveryMaterialIfNothingCanBeVerified() throws Exception {
        File root = temporary.newFolder(); File original = backup(root, true, 1);
        assertNull(UpdateFiles.pruneBackups(root, null, directory -> false));
        assertTrue(original.exists());
    }
}
