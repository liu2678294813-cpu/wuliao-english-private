package com.wuliao.english;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class ManualBackupBridgeTest {
    @Test public void realCapacitorJsonOffsets() throws Exception {
        for (long offset : new long[]{0, 196608, 3221225472L}) {
            JSObject json = new JSObject("{\"offset\":" + offset + "}");
            PluginCall call = new PluginCall(null, "ManualBackup", "test", "write", json);
            if (offset < Integer.MAX_VALUE) assertEquals(Long.valueOf(-1), call.getLong("offset", -1L));
            assertEquals(offset, BackupChunkPosition.read(call.getData().opt("offset")));
        }
    }
}
