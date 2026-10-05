import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA = "anticodex-antigravity-accounts-v1";
const FILE_NAME = "antigravity-accounts.json";
const ACCOUNT_ID = /^sha256:[a-f0-9]{64}$/;
const CREDENTIAL_HASH = /^[a-f0-9]{64}$/;
const SEALED = /^dpapi:v1:[A-Za-z0-9+/]+={0,2}$/;
const SENSITIVE_QUOTA_FIELD = /(?:auth|credential|secret|token|key)/i;

function emptyState() {
  return { schema: SCHEMA, activeId: null, accounts: [] };
}

function clone(value) {
  return structuredClone(value);
}

function normalizedLabel(value, fallback = "") {
  const label = String(value ?? "").trim() || String(fallback ?? "").trim();
  if (!label) throw new Error("Account label is required.");
  if (label.length > 200) throw new Error("Account label is too long.");
  return label;
}

function normalizeResetTime(value) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

export function normalizeAccountQuota(payload) {
  const groups = Array.isArray(payload?.command?.data?.groups) ? payload.command.data.groups : [];
  return {
    status: typeof payload?.status === "string" ? payload.status : "UNKNOWN",
    num_turns: Number.isInteger(payload?.num_turns) ? payload.num_turns : null,
    groups: groups.filter((group) => group && typeof group === "object" && !Array.isArray(group)).map((group) => {
      const normalized = {};
      for (const [key, value] of Object.entries(group)) {
        if (key === "buckets" || SENSITIVE_QUOTA_FIELD.test(key)) continue;
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) normalized[key] = value;
      }
      normalized.buckets = (Array.isArray(group.buckets) ? group.buckets : []).map((bucket) => ({
        window: typeof bucket?.window === "string" && bucket.window ? bucket.window : null,
        remaining_fraction: Number.isFinite(bucket?.remaining_fraction)
          && bucket.remaining_fraction >= 0
          && bucket.remaining_fraction <= 1
          ? bucket.remaining_fraction
          : null,
        reset_time: normalizeResetTime(bucket?.reset_time),
      }));
      return normalized;
    }),
  };
}

function sanitizeStoredQuota(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = normalizeAccountQuota({
    status: value.status,
    num_turns: value.num_turns,
    command: { data: { groups: Array.isArray(value.groups) ? value.groups : [] } },
  });
  const fetchedAt = normalizeResetTime(value.fetchedAt);
  return fetchedAt ? { ...normalized, fetchedAt } : normalized;
}

function quotaSnapshot(payload) {
  return { ...normalizeAccountQuota(payload), fetchedAt: new Date().toISOString() };
}

function validateCapture(value) {
  if (!value || typeof value !== "object") throw new Error("Antigravity credential capture is invalid.");
  const id = String(value.id || "").toLowerCase();
  const maskedEmail = String(value.maskedEmail || "");
  const sealed = String(value.sealed || "");
  const credentialHash = String(value.credentialHash || "").toLowerCase();
  if (!ACCOUNT_ID.test(id) || !maskedEmail || !SEALED.test(sealed) || !CREDENTIAL_HASH.test(credentialHash)) {
    throw new Error("Antigravity credential capture is invalid.");
  }
  return { id, maskedEmail, sealed, credentialHash };
}

function validateStoredAccount(value) {
  const capture = validateCapture(value);
  return {
    ...capture,
    label: normalizedLabel(value.label, capture.maskedEmail),
    quota: sanitizeStoredQuota(value.quota),
  };
}

function sanitizeAccount(account) {
  return {
    id: account.id,
    label: account.label,
    maskedEmail: account.maskedEmail,
    quota: sanitizeStoredQuota(account.quota),
  };
}

function publicState(state) {
  return {
    activeId: state.activeId,
    accounts: state.accounts.map(sanitizeAccount),
  };
}

function findAccount(state, id) {
  const normalized = String(id || "").toLowerCase();
  const account = state.accounts.find((value) => value.id === normalized);
  if (!account) throw new Error("Antigravity account does not exist.");
  return account;
}

function upsertAccount(state, capture, quota, label) {
  const index = state.accounts.findIndex((value) => value.id === capture.id);
  const previous = index >= 0 ? state.accounts[index] : null;
  const account = {
    ...capture,
    label: normalizedLabel(label, previous?.label || capture.maskedEmail),
    quota: quota ?? previous?.quota ?? null,
  };
  if (index >= 0) state.accounts[index] = account;
  else state.accounts.push(account);
  return account;
}

function combinedError(primary, failures = []) {
  const messages = [primary, ...failures]
    .filter(Boolean)
    .map((error) => String(error?.message || error));
  return new Error(messages.join("; "));
}

function startupUnconfirmedError() {
  return new Error("账号状态已保存，但 Antigravity 启动未确认，请手动检查。");
}

function loginIdentityUncertainError() {
  return new Error("Antigravity 登录停止未确认，当前账号未知；请手动检查。");
}

function reportProgress(onProgress, message) {
  if (typeof onProgress !== "function") return;
  try { onProgress(message); } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureWithQuotaFallback(driver) {
  try {
    return { captured: validateCapture(await driver.capture()), quota: null };
  } catch {
    const quota = quotaSnapshot(await driver.quota());
    return { captured: validateCapture(await driver.capture()), quota };
  }
}

async function openAndVerifyIdentity(driver, expectedId) {
  try {
    await driver.openDesktop();
    let lastIdentityError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (await driver.desktopIdentity() === expectedId) return;
        lastIdentityError = new Error("identity mismatch");
      } catch (error) {
        lastIdentityError = error;
      }
      if (attempt < 2) await sleep(300);
    }
    throw lastIdentityError || new Error("identity mismatch");
  } catch {
    const error = new Error("Antigravity Desktop identity could not be confirmed after opening.");
    error.credentialRestoreUnsafe = true;
    throw error;
  }
}

async function writeStateAtomic(path, state) {
  const root = dirname(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const pending = join(root, `.${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(pending, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(pending, path);
    await chmod(path, 0o600);
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

async function readState(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new Error("Antigravity account store is invalid.");
  }
  if (value?.schema !== SCHEMA || !Array.isArray(value.accounts)) {
    throw new Error("Antigravity account store is invalid.");
  }
  const accounts = value.accounts.map(validateStoredAccount);
  const ids = new Set();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new Error("Antigravity account store contains duplicate account ids.");
    ids.add(account.id);
  }
  const activeId = value.activeId == null ? null : String(value.activeId).toLowerCase();
  if (activeId && !accounts.some((account) => account.id === activeId)) {
    throw new Error("Antigravity account store has an invalid active account.");
  }
  return { schema: SCHEMA, activeId, accounts };
}

export function createAntigravityAccountManager(options = {}) {
  const stateRoot = String(options.stateRoot || "").trim();
  const driver = options.driver;
  if (!stateRoot) throw new TypeError("stateRoot is required.");
  for (const method of ["capture", "restore", "quota", "beginChange", "endChange", "openDesktop", "hasDesktop", "desktopIdentity"]) {
    if (typeof driver?.[method] !== "function") throw new TypeError(`driver.${method}() is required.`);
  }
  const statePath = join(stateRoot, FILE_NAME);
  const writeState = options.writeState || ((path, state, writeDefault) => writeDefault(path, state));
  let busy = false;

  const load = () => readState(statePath);
  const save = (state) => writeState(statePath, state, writeStateAtomic);
  const withLock = async (operation) => {
    if (busy) throw new Error("An Antigravity account operation is already in progress.");
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  };

  async function captureCurrent({ label, onProgress } = {}) {
    return withLock(async () => {
      reportProgress(onProgress, "正在确认官方 Antigravity 登录状态。");
      if (typeof driver.hasCredential === "function" && !(await driver.hasCredential())) {
        throw new Error("请先在官方 Antigravity 中完成登录，再保存当前账号。");
      }
      reportProgress(onProgress, "正在读取当前账号额度。");
      const quota = quotaSnapshot(await driver.quota());
      const captured = validateCapture(await driver.capture());
      const state = await load();
      const account = upsertAccount(state, captured, quota, label);
      state.activeId = captured.id;
      await save(state);
      reportProgress(onProgress, "当前账号已保存。");
      return sanitizeAccount(account);
    });
  }

  async function activate({ id, acknowledgeRestart = false, onProgress } = {}) {
    return withLock(async () => {
      const original = await load();
      const target = findAccount(original, id);
      const desktopRunning = await driver.hasDesktop();
      let desktopIdentity = null;
      if (desktopRunning) {
        reportProgress(onProgress, "正在打开 Antigravity。");
        await driver.openDesktop();
        reportProgress(onProgress, "正在核对当前账号。");
        desktopIdentity = await driver.desktopIdentity();
      } else {
        reportProgress(onProgress, "正在核对当前账号。");
      }
      if (desktopRunning && desktopIdentity === target.id) {
        const state = clone(original);
        state.activeId = target.id;
        if (JSON.stringify(state) !== JSON.stringify(original)) await save(state);
        reportProgress(onProgress, "账号已启用，Antigravity 已打开并完成登录核验。");
        return publicState(state);
      }
      const observedResult = await captureWithQuotaFallback(driver);
      const observedQuota = observedResult.quota;
      const observed = observedResult.captured;
      if (!desktopRunning && observed.id === target.id) {
        await openAndVerifyIdentity(driver, target.id);
        const state = clone(original);
        state.activeId = target.id;
        await save(state);
        reportProgress(onProgress, "账号已启用，Antigravity 已打开并完成登录核验。");
        return publicState(state);
      }
      if (acknowledgeRestart !== true) throw new Error("Antigravity restart acknowledgement is required.");
      desktopIdentity ||= observed.id;
      if (observed.id !== desktopIdentity) throw new Error("Antigravity Desktop and credential identities do not match.");

      let context;
      let endAttempted = false;
      let credentialMayHaveChanged = false;
      let rollbackState = clone(original);
      let previousCapture = observed;
      let stateCommitted = false;
      try {
        reportProgress(onProgress, "正在安全切换账号。");
        context = await driver.beginChange({ acknowledgeRestart: true });
        previousCapture = validateCapture(await driver.capture());
        if (previousCapture.id !== observed.id) throw new Error("Antigravity previous account identity mismatch.");
        const prepared = clone(original);
        upsertAccount(prepared, previousCapture, observedQuota, undefined);
        prepared.activeId = previousCapture.id;
        await save(prepared);
        rollbackState = clone(prepared);

        credentialMayHaveChanged = true;
        await driver.restore(target.sealed);
        reportProgress(onProgress, "正在验证目标账号。");
        const targetQuota = quotaSnapshot(await driver.quota());
        const targetCapture = validateCapture(await driver.capture());
        if (targetCapture.id !== target.id) throw new Error("Antigravity target account identity mismatch.");
        const committed = clone(prepared);
        upsertAccount(committed, targetCapture, targetQuota, target.label);
        committed.activeId = target.id;
        await save(committed);
        stateCommitted = true;
        reportProgress(onProgress, "账号已切换，正在打开 Antigravity。");
        await openAndVerifyIdentity(driver, target.id);
        credentialMayHaveChanged = false;
        reportProgress(onProgress, "账号已启用，Antigravity 已打开并完成登录核验。");
        return publicState(committed);
      } catch (error) {
        if (stateCommitted && error?.credentialRestoreUnsafe === true) throw startupUnconfirmedError();
        const failures = [];
        if (credentialMayHaveChanged && previousCapture?.sealed) {
          try { await driver.restore(previousCapture.sealed); } catch (rollbackError) { failures.push(`credential rollback failed: ${rollbackError?.message || rollbackError}`); }
        }
        try { await save(rollbackState); } catch (rollbackError) { failures.push(`state rollback failed: ${rollbackError?.message || rollbackError}`); }
        if (context && !endAttempted) {
          try { await driver.endChange(context); } catch (cleanupError) { failures.push(`desktop cleanup failed: ${cleanupError?.message || cleanupError}`); }
        }
        throw combinedError(error, failures);
      }
    });
  }

  async function login({ label, acknowledgeRestart = false, onProgress } = {}) {
    return withLock(async () => {
      if (acknowledgeRestart !== true) throw new Error("Antigravity restart acknowledgement is required.");
      if (typeof driver.login !== "function") throw new Error("Antigravity official login is unavailable.");
      const original = await load();
      const hasPreviousCredential = typeof driver.hasCredential === "function"
        ? await driver.hasCredential()
        : original.accounts.length > 0;
      let context;
      let endAttempted = false;
      let loginStarted = false;
      let credentialMayHaveChanged = false;
      let previousCapture = null;
      let rollbackState = clone(original);
      let stateCommitted = false;
      try {
        reportProgress(onProgress, "正在保存当前账号。");
        context = await driver.beginChange({ acknowledgeRestart: true });
        const prepared = clone(original);
        if (hasPreviousCredential) {
          const previousQuota = quotaSnapshot(await driver.quota());
          previousCapture = validateCapture(await driver.capture());
          const known = original.accounts.find((account) => account.id === previousCapture.id);
          upsertAccount(prepared, previousCapture, previousQuota, known?.label);
          prepared.activeId = previousCapture.id;
          await save(prepared);
          rollbackState = clone(prepared);
        }
        loginStarted = true;
        credentialMayHaveChanged = true;
        reportProgress(onProgress, "请在官方 Antigravity 完成登录。");
        await driver.login({ acknowledgeRestart: true });
        reportProgress(onProgress, "正在保存新账号。");
        const newQuota = quotaSnapshot(await driver.quota());
        const added = validateCapture(await driver.capture());
        upsertAccount(prepared, added, newQuota, label);
        prepared.activeId = added.id;
        await save(prepared);
        stateCommitted = true;
        reportProgress(onProgress, "新账号已启用，正在打开 Antigravity。");
        await openAndVerifyIdentity(driver, added.id);
        credentialMayHaveChanged = false;
        reportProgress(onProgress, "账号已启用，Antigravity 已打开并完成登录核验。");
        return publicState(prepared);
      } catch (error) {
        const failures = [];
        let credentialRestoreUnsafe = error?.credentialRestoreUnsafe === true;
        if (!credentialRestoreUnsafe && loginStarted && typeof driver.cancelLogin === "function") {
          try {
            await driver.cancelLogin();
          } catch (cancelError) {
            credentialRestoreUnsafe = cancelError?.credentialRestoreUnsafe === true;
            failures.push("Antigravity login cleanup failed.");
          }
        }
        if (credentialRestoreUnsafe) {
          if (stateCommitted) throw startupUnconfirmedError();
          const unknownState = clone(rollbackState);
          unknownState.activeId = null;
          try {
            await save(unknownState);
          } catch {
            failures.push("Failed to save the unknown Antigravity account state.");
          }
          throw combinedError(loginIdentityUncertainError(), failures);
        }
        if (credentialMayHaveChanged && previousCapture?.sealed) {
          try { await driver.restore(previousCapture.sealed); } catch (rollbackError) { failures.push(`credential rollback failed: ${rollbackError?.message || rollbackError}`); }
        }
        try { await save(rollbackState); } catch (rollbackError) { failures.push(`state rollback failed: ${rollbackError?.message || rollbackError}`); }
        if (context && !endAttempted) {
          try { await driver.endChange(context); } catch (cleanupError) { failures.push(`desktop cleanup failed: ${cleanupError?.message || cleanupError}`); }
        }
        throw combinedError(error, failures);
      }
    });
  }

  async function refresh({ id, all = false, acknowledgeRestart = false, onProgress } = {}) {
    return withLock(async () => {
      reportProgress(onProgress, "正在刷新账号额度。");
      const original = await load();
      if (all && id) throw new Error("Choose either one Antigravity account or all accounts.");
      const targets = all
        ? [...original.accounts]
        : [findAccount(original, id || original.activeId)];
      if (targets.length === 0) throw new Error("No Antigravity accounts are managed.");

      if (!all && targets[0].id === original.activeId) {
        const quota = quotaSnapshot(await driver.quota());
        const captured = validateCapture(await driver.capture());
        if (captured.id !== targets[0].id) throw new Error("Antigravity active account identity mismatch.");
        const state = clone(original);
        upsertAccount(state, captured, quota, targets[0].label);
        await save(state);
        reportProgress(onProgress, "账号额度已刷新。");
        return publicState(state);
      }
      if (acknowledgeRestart !== true) throw new Error("Antigravity restart acknowledgement is required.");
      if (!original.activeId) throw new Error("The active Antigravity account is unknown.");

      let context;
      let endAttempted = false;
      let credentialMayHaveChanged = false;
      let initialCapture = null;
      let stateCommitted = false;
      try {
        context = await driver.beginChange({ acknowledgeRestart: true });
        const initialQuota = quotaSnapshot(await driver.quota());
        initialCapture = validateCapture(await driver.capture());
        if (initialCapture.id !== original.activeId) throw new Error("Antigravity active account identity mismatch.");
        const working = clone(original);
        const active = findAccount(working, initialCapture.id);
        upsertAccount(working, initialCapture, initialQuota, active.label);

        for (const target of targets) {
          if (target.id === initialCapture.id) continue;
          credentialMayHaveChanged = true;
          await driver.restore(target.sealed);
          const quota = quotaSnapshot(await driver.quota());
          const captured = validateCapture(await driver.capture());
          if (captured.id !== target.id) throw new Error("Antigravity target account identity mismatch.");
          upsertAccount(working, captured, quota, target.label);
        }
        if (credentialMayHaveChanged) {
          await driver.restore(initialCapture.sealed);
          credentialMayHaveChanged = false;
        }
        working.activeId = original.activeId;
        await save(working);
        stateCommitted = true;
        endAttempted = true;
        await driver.endChange(context);
        reportProgress(onProgress, "账号额度已刷新。");
        return publicState(working);
      } catch (error) {
        if (stateCommitted && error?.credentialRestoreUnsafe === true) throw startupUnconfirmedError();
        const failures = [];
        if (credentialMayHaveChanged && initialCapture?.sealed) {
          try { await driver.restore(initialCapture.sealed); } catch (rollbackError) { failures.push(`credential rollback failed: ${rollbackError?.message || rollbackError}`); }
        }
        if (context && !endAttempted) {
          try { await driver.endChange(context); } catch (cleanupError) { failures.push(`desktop cleanup failed: ${cleanupError?.message || cleanupError}`); }
        }
        throw combinedError(error, failures);
      }
    });
  }

  async function remove({ id, onProgress } = {}) {
    return withLock(async () => {
      reportProgress(onProgress, "正在移除受管账号。");
      const state = await load();
      const target = findAccount(state, id);
      state.accounts = state.accounts.filter((account) => account.id !== target.id);
      if (state.activeId === target.id) state.activeId = null;
      await save(state);
      reportProgress(onProgress, "受管账号已移除。");
      return publicState(state);
    });
  }

  async function renameAccount({ id, label, onProgress } = {}) {
    return withLock(async () => {
      reportProgress(onProgress, "正在更新账号名称。");
      const state = await load();
      const target = findAccount(state, id);
      target.label = normalizedLabel(label);
      await save(state);
      reportProgress(onProgress, "账号名称已更新。");
      return publicState(state);
    });
  }

  return {
    list: async () => publicState(await load()),
    captureCurrent,
    activate,
    login,
    refresh,
    remove,
    rename: renameAccount,
  };
}
