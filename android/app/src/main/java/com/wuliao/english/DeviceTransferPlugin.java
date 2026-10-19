package com.wuliao.english;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import android.util.Base64;

/** Ciphertext-only, foreground LAN transport. No access to learning databases. */
@CapacitorPlugin(name = "DeviceTransfer")
public class DeviceTransferPlugin extends Plugin {
    private final ExecutorService calls = Executors.newSingleThreadExecutor();
    private final ExecutorService incoming = Executors.newSingleThreadExecutor();
    private volatile ServerSocket server;
    private JSONObject session;
    private File directory;
    private Timer expiry;
    private static final int MAX_BODY = 320000;

    @PluginMethod public void command(PluginCall call) {
        calls.execute(() -> {
            try { call.resolve(JSObject.fromJSONObject(command(call.getString("action", ""), call.getObject("args", new JSObject())))); }
            catch (Exception e) { call.reject("设备互传失败：" + e.getMessage(), e); }
        });
    }
    private static String random() {
        byte[] b = new byte[24]; new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder(); for (byte v : b) s.append(String.format(Locale.ROOT, "%02x", v & 255)); return s.toString();
    }
    static boolean privateHost(String host) {
        if (!host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
        String[] p = host.split("\\."); int[] a = new int[4];
        try { for (int i = 0; i < 4; i++) { a[i] = Integer.parseInt(p[i]); if (a[i] < 0 || a[i] > 255) return false; } }
        catch (Exception e) { return false; }
        return a[0] == 10 || a[0] == 192 && a[1] == 168 || a[0] == 172 && a[1] >= 16 && a[1] <= 31 || host.equals("127.0.0.1");
    }
    private synchronized JSONObject status() throws Exception {
        if (session == null) throw new IOException("接收任务已结束");
        JSONObject result = new JSONObject();
        for (String key : new String[]{"id", "state", "offer", "finish", "chunks", "bytes"}) if (session.has(key)) result.put(key, session.get(key));
        return result;
    }
    private synchronized JSONObject command(String action, JSONObject args) throws Exception {
        if (action.equals("stop")) { stop(); return new JSONObject(); }
        if (action.equals("start")) {
            stop();
            File parent = new File(getContext().getCacheDir(), "device-transfer");
            File[] stale = parent.listFiles();
            if (stale != null) for (File folder : stale) {
                if (!folder.getName().matches("[a-f0-9]{48}")) continue;
                File[] pieces = folder.listFiles(); if (pieces != null) for (File piece : pieces) if (piece.isFile()) piece.delete();
                folder.delete();
            }
            directory = new File(parent, random());
            if (!directory.mkdirs()) throw new IOException("无法创建接收暂存区");
            session = new JSONObject().put("id", directory.getName()).put("token", random()).put("state", "waiting").put("chunks", 0).put("bytes", 0);
            ServerSocket listening = new ServerSocket(0); server = listening;
            Thread accept = new Thread(() -> {
                while (!listening.isClosed()) {
                    try { Socket socket = listening.accept(); incoming.execute(() -> serve(socket)); }
                    catch (IOException ignored) { break; }
                }
            }, "wuliao-lan-transfer"); accept.setDaemon(true); accept.start();
            expiry = new Timer(true); expiry.schedule(new TimerTask() { public void run() { synchronized (DeviceTransferPlugin.this) { if (session != null && !session.optString("state").equals("accepted") && !session.optString("state").equals("complete")) stop(); } } }, 600000);
            JSONArray hosts = new JSONArray();
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                Enumeration<InetAddress> addresses = interfaces.nextElement().getInetAddresses();
                while (addresses.hasMoreElements()) { InetAddress a = addresses.nextElement(); if (a instanceof Inet4Address && !a.isLoopbackAddress() && privateHost(a.getHostAddress())) hosts.put(a.getHostAddress()); }
            }
            return new JSONObject().put("id", session.getString("id")).put("token", session.getString("token")).put("hosts", hosts).put("port", listening.getLocalPort());
        }
        if (action.equals("remote")) return requestRemote(args);
        if (session == null) throw new IOException("接收任务已结束，请重新打开接收");
        if (action.equals("status")) return status();
        if (action.equals("accept")) {
            if (!session.getString("state").equals("offered")) throw new IOException("没有等待确认的设备");
            session.put("state", "accepted"); expiry.cancel(); return new JSONObject();
        }
        if (action.equals("read")) {
            int index = args.getInt("index");
            if (!session.getString("state").equals("complete") || index < 0 || index >= session.getInt("chunks")) throw new IOException("备份尚未接收完整");
            try (InputStream input = new FileInputStream(new File(directory, index + ".bin"))) { return new JSONObject().put("data", Base64.encodeToString(readExact(input, (int) new File(directory, index + ".bin").length()), Base64.NO_WRAP)); }
        }
        throw new IOException("未知本机操作");
    }
    private synchronized JSONObject receive(String action, JSONObject body, String token) throws Exception {
        if (session == null || !session.getString("token").equals(token)) throw new IOException("连接码无效或会话已结束");
        if (action.equals("status")) return status();
        if (action.equals("offer")) {
            if (!session.getString("state").equals("waiting") || body.getString("data").length() > 16384) throw new IOException("接收端当前不可连接");
            session.put("offer", body.getString("data")).put("state", "offered"); return new JSONObject();
        }
        if (!session.getString("state").equals("accepted")) throw new IOException("接收端尚未确认或会话已完成");
        if (action.equals("chunk")) {
            int index = body.getInt("index"); String data = body.getString("data");
            if (index != session.getInt("chunks") || !data.matches("[A-Za-z0-9+/]+={0,2}")) throw new IOException("传输分块顺序或编码错误");
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            if (bytes.length < 29 || bytes.length > 196636) throw new IOException("传输分块大小无效");
            if (directory.getUsableSpace() < bytes.length + 32L * 1024 * 1024) throw new IOException("接收设备存储空间不足");
            File target = new File(directory, index + ".bin");
            if (!target.createNewFile()) throw new IOException("重复分块");
            try (OutputStream output = new FileOutputStream(target)) { output.write(bytes); }
            session.put("chunks", index + 1).put("bytes", session.getLong("bytes") + bytes.length); return new JSONObject();
        }
        if (action.equals("finish")) {
            if (body.getString("data").length() > 4096 || session.getInt("chunks") == 0) throw new IOException("结束信息无效");
            session.put("finish", body.getString("data")).put("state", "complete"); return new JSONObject();
        }
        throw new IOException("未知传输操作");
    }
    private static String line(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); int c;
        while ((c = input.read()) != -1 && c != '\n') { if (out.size() > 8192) throw new IOException("请求头过大"); if (c != '\r') out.write(c); }
        return out.toString("UTF-8");
    }
    private static byte[] readExact(InputStream input, int length) throws IOException {
        if (length < 0 || length > MAX_BODY) throw new IOException("传输分块过大");
        byte[] bytes = new byte[length]; int at = 0, n;
        while (at < length && (n = input.read(bytes, at, length - at)) > 0) at += n;
        if (at != length) throw new IOException("传输中断"); return bytes;
    }
    private void serve(Socket socket) {
        try (Socket client = socket) {
            client.setSoTimeout(20000); InputStream input = new BufferedInputStream(client.getInputStream());
            JSONObject response; int code = 200;
            try {
                String first = line(input); String[] parts = first.split(" ");
                if (parts.length != 3 || !parts[0].equals("POST") || !parts[1].matches("/transfer/[a-z]+")) throw new IOException("未知传输路径");
                Map<String, String> headers = new HashMap<>(); String h; int count = 0;
                while (!(h = line(input)).isEmpty()) { if (++count > 40) throw new IOException("请求头过多"); int colon = h.indexOf(':'); if (colon <= 0) throw new IOException("请求头无效"); headers.put(h.substring(0, colon).toLowerCase(Locale.ROOT), h.substring(colon + 1).trim()); }
                if (headers.containsKey("origin") || headers.containsKey("transfer-encoding")) throw new IOException("仅允许应用配对连接");
                JSONObject body = new JSONObject(new String(readExact(input, Integer.parseInt(headers.getOrDefault("content-length", "0"))), StandardCharsets.UTF_8));
                response = receive(parts[1].substring(10), body, headers.get("x-transfer-token"));
            } catch (Exception e) { code = 400; response = new JSONObject().put("error", e.getMessage()); }
            byte[] bytes = response.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream output = client.getOutputStream(); output.write(("HTTP/1.1 " + code + " Result\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + bytes.length + "\r\n\r\n").getBytes(StandardCharsets.UTF_8)); output.write(bytes); output.flush();
        } catch (Exception ignored) { }
    }
    private JSONObject requestRemote(JSONObject args) throws Exception {
        String host = args.getString("host"), method = args.getString("method"), token = args.getString("token"); int port = args.getInt("port");
        if (!privateHost(host) || port < 1 || port > 65535 || !Arrays.asList("offer", "status", "chunk", "finish").contains(method) || !token.matches("[a-f0-9]{48}")) throw new IOException("只支持本地网络设备");
        byte[] body = args.optJSONObject("body").toString().getBytes(StandardCharsets.UTF_8);
        if (body.length > MAX_BODY) throw new IOException("传输分块过大");
        // Native sockets avoid widening the WebView's cleartext or mixed-content policy.
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), 10000); socket.setSoTimeout(20000);
            OutputStream output = socket.getOutputStream();
            output.write(("POST /transfer/" + method + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nConnection: close\r\nContent-Type: application/json\r\nX-Transfer-Token: " + token + "\r\nContent-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.UTF_8)); output.write(body); output.flush();
            InputStream input = new BufferedInputStream(socket.getInputStream()); String first = line(input), h; int length = -1, count = 0;
            while (!(h = line(input)).isEmpty()) { if (++count > 40) throw new IOException("响应头过多"); if (h.toLowerCase(Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(h.substring(15).trim()); }
            JSONObject result = new JSONObject(new String(readExact(input, length), StandardCharsets.UTF_8));
            if (!first.startsWith("HTTP/1.1 200")) throw new IOException(result.optString("error", "连接失败")); return result;
        }
    }
    private synchronized void stop() {
        if (expiry != null) expiry.cancel();
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        server = null; session = null;
        if (directory != null) { File[] files = directory.listFiles(); if (files != null) for (File f : files) f.delete(); directory.delete(); directory = null; }
    }
    @Override protected void handleOnDestroy() { stop(); calls.shutdownNow(); incoming.shutdownNow(); }
}
