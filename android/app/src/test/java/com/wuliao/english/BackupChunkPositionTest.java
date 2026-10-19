package com.wuliao.english;
import org.junit.Test;
import static org.junit.Assert.*;
public class BackupChunkPositionTest {
    @Test public void jsonNumberTypes() {
        assertEquals(0L, BackupChunkPosition.read(Integer.valueOf(0)));
        assertEquals(196608L, BackupChunkPosition.read(Integer.valueOf(196608)));
        assertEquals(3221225472L, BackupChunkPosition.read(Long.valueOf(3221225472L)));
        assertEquals(196608L, BackupChunkPosition.read(Double.valueOf(196608)));
    }
    @Test public void rejectsInvalidPositions() {
        for (Object value : new Object[]{null, "0", -1, 1.5, Double.NaN, Double.POSITIVE_INFINITY, 9007199254740992d}) {
            try { BackupChunkPosition.read(value); fail("accepted invalid position"); }
            catch (IllegalArgumentException expected) { }
        }
    }
}
