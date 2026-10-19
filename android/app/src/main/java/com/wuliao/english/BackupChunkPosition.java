package com.wuliao.english;

/** JSON small integers are Integer, not Long, in Capacitor PluginCall data. */
final class BackupChunkPosition {
    static long read(Object value) {
        if (!(value instanceof Number)) throw new IllegalArgumentException("备份位置必须是整数");
        double number = ((Number) value).doubleValue();
        if (Double.isNaN(number) || Double.isInfinite(number) || number < 0 || number > 9007199254740991d || number != Math.floor(number))
            throw new IllegalArgumentException("备份位置无效");
        return ((Number) value).longValue();
    }
}
