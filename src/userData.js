import { AppEvent } from "./events/eventTypes.js";
import { emitAppEvent } from "./events/appEvents.js";
import { inkStorageReady, isDurableInkKey, readDurableInk, writeDurableInk, listDurableInk } from "./durableInkStorage.js";
import { isSerializedInkSnapshot } from "./ink/inkSnapshot.js";

export const CURRENT_USER_KEY = "kaoyan_vocab_current_user";

const AUTH_DB_NAME = "KaoyanVocabDB";
const USERS_STORE = "users";
const ANDROID_PASSWORD_VERIFIER_PREFIX = "account:password-verifier:v1:";
const LEGACY_OWNER_KEY = "wuliao_auth_legacy_owner";
const USER_PREFIX = "wuliao:user:";
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_VERIFIER_FIELDS = Object.freeze([
  "passwordHash",
  "passwordSalt",
  "passwordIterations",
  "passwordVersion",
  "passwordUpdatedAt",
]);

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("数据库事务已取消"));
  });
}

function createMainVocabularySchema(database) {
  if (!database.objectStoreNames.contains("users")) {
    database.createObjectStore("users", { keyPath: "username" });
  }
  if (!database.objectStoreNames.contains("wordLists")) {
    const store = database.createObjectStore("wordLists", { keyPath: "id", autoIncrement: true });
    store.createIndex("username", "username", { unique: false });
    store.createIndex("[username+round+type]", ["username", "round", "type"], { unique: false });
  }
  if (!database.objectStoreNames.contains("screeningProgress")) {
    database.createObjectStore("screeningProgress", { keyPath: "username" });
  }
  if (!database.objectStoreNames.contains("screeningSessions")) {
    const store = database.createObjectStore("screeningSessions", { keyPath: "sessionKey" });
    store.createIndex("username", "username", { unique: false });
    store.createIndex("[username+listId+round]", ["username", "listId", "round"], { unique: false });
  }
  if (!database.objectStoreNames.contains("wordRecords")) {
    const store = database.createObjectStore("wordRecords", { keyPath: "id", autoIncrement: true });
    store.createIndex("[username+wordId]", ["username", "wordId"], { unique: false });
    store.createIndex("[username+round]", ["username", "round"], { unique: false });
  }
  if (!database.objectStoreNames.contains("confusionPairs")) {
    const store = database.createObjectStore("confusionPairs", { keyPath: "id", autoIncrement: true });
    store.createIndex("username", "username", { unique: false });
    store.createIndex("[username+round]", ["username", "round"], { unique: false });
  }
}

function openAuthDatabase() {
  return new Promise((resolve, reject) => {
    // Do not pass a fixed version here. Dexie stores version 5 as native
    // IndexedDB version 50, so opening an existing database with version 5
    // would throw VersionError and lock legacy users out of the app.
    const request = indexedDB.open(AUTH_DB_NAME);
    request.onupgradeneeded = () => createMainVocabularySchema(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function androidSecureStore() {
  return globalThis.window?.AndroidSecureStore || null;
}

function androidPasswordVerifierKey(username) {
  return `${ANDROID_PASSWORD_VERIFIER_PREFIX}${encodeURIComponent(username)}`;
}

function passwordVerifierFromAccount(account) {
  if (!account?.passwordHash || !account?.passwordSalt) return null;
  return Object.fromEntries(PASSWORD_VERIFIER_FIELDS.map((field) => [field, account[field]]));
}

function accountWithoutPasswordVerifier(account) {
  const profile = { ...(account || {}) };
  PASSWORD_VERIFIER_FIELDS.forEach((field) => { delete profile[field]; });
  return profile;
}

function parsePasswordVerifier(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed?.passwordHash && parsed?.passwordSalt ? parsed : null;
  } catch {
    return null;
  }
}

async function putAccountRecord(account) {
  const database = await openAuthDatabase();
  try {
    const transaction = database.transaction(USERS_STORE, "readwrite");
    transaction.objectStore(USERS_STORE).put(account);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function writeAndroidPasswordVerifier(username, verifier, secureStore = androidSecureStore()) {
  const serialized = JSON.stringify(verifier);
  const key = androidPasswordVerifierKey(username);
  await secureStore.set(key, serialized);
  const confirmed = String(await secureStore.get(key) || "");
  if (confirmed !== serialized) throw new Error("Android 安全存储无法确认账号凭据写入");
}

async function migrateAndroidPasswordVerifier(account) {
  const secureStore = androidSecureStore();
  if (!secureStore?.get || !secureStore?.set || !account?.username) return account;

  const profile = accountWithoutPasswordVerifier(account);
  const legacyVerifier = passwordVerifierFromAccount(account);
  const storedVerifier = parsePasswordVerifier(
    await secureStore.get(androidPasswordVerifierKey(account.username)),
  );
  const verifier = storedVerifier || legacyVerifier;
  if (!verifier) return profile;

  if (!storedVerifier) {
    await writeAndroidPasswordVerifier(account.username, verifier, secureStore);
  }
  if (legacyVerifier) await putAccountRecord(profile);
  return { ...profile, ...verifier };
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export function getCurrentUsername() {
  return localStorage.getItem(CURRENT_USER_KEY)?.trim() || "";
}

export function setCurrentUsername(username) {
  const value = String(username || "").trim();
  if (value) localStorage.setItem(CURRENT_USER_KEY, value);
  else localStorage.removeItem(CURRENT_USER_KEY);
  emitAppEvent(AppEvent.ACCOUNT_CHANGED, { username: value });
}

export function userStoragePrefix(username = getCurrentUsername()) {
  if (!username) return "";
  return `${USER_PREFIX}${encodeURIComponent(username)}:`;
}

export function scopedUserKey(key, username = getCurrentUsername()) {
  const prefix = userStoragePrefix(username);
  return prefix ? `${prefix}${key}` : key;
}

export function getUserItem(key, username = getCurrentUsername()) {
  if (!username) return null;
  if (isDurableInkKey(key) && inkStorageReady(username)) return readDurableInk(username, key);
  const scopedValue = localStorage.getItem(scopedUserKey(key, username));
  if (scopedValue !== null) return scopedValue;
  if (localStorage.getItem(LEGACY_OWNER_KEY) === username) {
    return localStorage.getItem(key);
  }
  return null;
}

export function setUserItem(key, value, username = getCurrentUsername()) {
  if (!username) throw new Error("请先登录账号");
  if (isDurableInkKey(key) && inkStorageReady(username)) return writeDurableInk(username, key,
    isSerializedInkSnapshot(value) ? value : String(value));
  if (
    localStorage.getItem(LEGACY_OWNER_KEY) === username
    && localStorage.getItem(key) !== null
    && localStorage.getItem(scopedUserKey(key, username)) === null
  ) {
    localStorage.setItem(key, String(value));
    return;
  }
  localStorage.setItem(scopedUserKey(key, username), String(value));
}

export function removeUserItem(key, username = getCurrentUsername()) {
  if (!username) return;
  if (isDurableInkKey(key) && inkStorageReady(username)) writeDurableInk(username, key, null);
  localStorage.removeItem(scopedUserKey(key, username));
  if (localStorage.getItem(LEGACY_OWNER_KEY) === username) localStorage.removeItem(key);
}

export function listUserItems(prefix = "", username = getCurrentUsername()) {
  const scopedPrefix = `${userStoragePrefix(username)}${prefix}`;
  if (!username) return [];
  const items = new Map();
  if (localStorage.getItem(LEGACY_OWNER_KEY) === username) {
    for (let index = 0; index < localStorage.length; index += 1) {
      const rawKey = localStorage.key(index);
      if (!rawKey?.startsWith(prefix) || rawKey.startsWith(USER_PREFIX)) continue;
      items.set(rawKey, { key: rawKey, value: localStorage.getItem(rawKey) });
    }
  }
  for (let index = 0; index < localStorage.length; index += 1) {
    const rawKey = localStorage.key(index);
    if (!rawKey?.startsWith(scopedPrefix)) continue;
    const key = rawKey.slice(userStoragePrefix(username).length);
    items.set(key, {
      key,
      value: localStorage.getItem(rawKey),
    });
  }
  if (inkStorageReady(username)) {
    for (const key of items.keys()) if (isDurableInkKey(key)) items.delete(key);
    for (const entry of listDurableInk(username)) if (entry.key.startsWith(prefix)) items.set(entry.key, entry);
  }
  return [...items.values()];
}

export function migrateLegacyUserStorage(username) {
  if (!username) return false;
  const existingOwner = localStorage.getItem(LEGACY_OWNER_KEY);
  if (existingOwner && existingOwner !== username) return false;
  const legacyKeys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("wuliao:") && !key.startsWith(USER_PREFIX)) legacyKeys.push(key);
  }

  // Legacy handwriting can nearly fill WebView localStorage. Duplicating every
  // value under an account prefix would exceed the quota. Keep the original
  // records in place and mark a single logical owner instead. Remove only
  // byte-for-byte identical copies left by an interrupted older migration.
  legacyKeys.forEach((key) => {
    const target = scopedUserKey(key, username);
    const legacyValue = localStorage.getItem(key);
    if (legacyValue !== null && localStorage.getItem(target) === legacyValue) {
      localStorage.removeItem(target);
    }
  });
  localStorage.setItem(LEGACY_OWNER_KEY, username);
  return !existingOwner;
}

export async function listAccounts() {
  const database = await openAuthDatabase();
  let users;
  try {
    const transaction = database.transaction(USERS_STORE, "readonly");
    users = await requestResult(transaction.objectStore(USERS_STORE).getAll());
  } finally {
    database.close();
  }
  const migrated = [];
  for (const account of users) migrated.push(await migrateAndroidPasswordVerifier(account));
  return migrated.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getAccount(username) {
  if (!username) return null;
  const database = await openAuthDatabase();
  try {
    const transaction = database.transaction(USERS_STORE, "readonly");
    const account = await requestResult(transaction.objectStore(USERS_STORE).get(username));
    return await migrateAndroidPasswordVerifier(account);
  } finally {
    database.close();
  }
}

export async function saveAccountPassword(username, password, { createOnly = false } = {}) {
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername) throw new Error("请输入账号名");
  if (String(password || "").length < 6) throw new Error("密码至少需要 6 个字符");
  const existing = await getAccount(normalizedUsername);
  if (createOnly && existing) throw new Error("这个账号已经存在");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derivePassword(password, salt);
  const next = {
    ...(existing || {}),
    username: normalizedUsername,
    createdAt: existing?.createdAt || Date.now(),
    passwordHash,
    passwordSalt: bytesToBase64(salt),
    passwordIterations: PASSWORD_ITERATIONS,
    passwordVersion: 1,
    passwordUpdatedAt: Date.now(),
  };
  const secureStore = androidSecureStore();
  if (secureStore?.get && secureStore?.set) {
    await writeAndroidPasswordVerifier(normalizedUsername, passwordVerifierFromAccount(next), secureStore);
    await putAccountRecord(accountWithoutPasswordVerifier(next));
  } else {
    await putAccountRecord(next);
  }
  return normalizedUsername;
}

export async function verifyAccountPassword(username, password) {
  const account = await getAccount(username);
  if (!account?.passwordHash || !account.passwordSalt) return false;
  const candidate = await derivePassword(
    password,
    base64ToBytes(account.passwordSalt),
    account.passwordIterations || PASSWORD_ITERATIONS,
  );
  if (candidate.length !== account.passwordHash.length) return false;
  let difference = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ account.passwordHash.charCodeAt(index);
  }
  return difference === 0;
}
