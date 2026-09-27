// 稳定文件指纹：同一份 PDF 二进制再次导入必须生成相同指纹，用于稳定
// resourceId 与解析缓存 identity。禁止使用时间戳/随机值作为资源身份。

// SHA-256；无 WebCrypto 时退化为确定性 FNV-1a（仍与内容绑定，绝不随机）。
export async function computeFileFingerprint(fileOrBytes) {
  const bytes = fileOrBytes instanceof Uint8Array
    ? fileOrBytes
    : new Uint8Array(await fileOrBytes.arrayBuffer());
  try {
    if (globalThis.crypto?.subtle?.digest) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // 退化为确定性哈希
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv-${hash.toString(16).padStart(8, "0")}`;
}

// 稳定 resourceId：用户 + 文件内容。同一用户同一 PDF 重复导入得到相同 ID。
export function stablePdfResourceId(fingerprint, username = "") {
  const suffix = username ? `-${encodeURIComponent(username).slice(0, 24)}` : "";
  return `custom-${fingerprint}${suffix}`;
}
