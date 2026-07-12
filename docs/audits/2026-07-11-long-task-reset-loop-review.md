# Anti-Codex 长任务自动续写边界审计报告 (2026-07-11)

本报告针对 Anti-Codex (`deepcodex`) 项目中长任务在**会话锁重置 (Session Lock Reset)** 或**重复成功写入 (Duplicate Successful Writes)** 发生后，仍可能出现自动续写（自动重试/无限循环）的代码边界进行只读审计，并提出最小化修改建议。

---

## 一、 已证实的代码事实 (Verified Code Facts)

通过对 [adaptive-server.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs)、[antigravity-session-lock.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/antigravity-session-lock.mjs) 和 [antigravity-request-registry.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/antigravity-request-registry.mjs) 的代码结构进行梳理，证实了以下边界逻辑缺陷：

### 1. 会话锁重置后的续写边界与漏洞 (Session Lock Reset Gaps)

当触发 `resetAntigravitySessionLock`（通常由管理页面或 API 调用）时，系统执行以下操作：
1. **取消当前请求**：通过 `ACTIVE_ANTIGRAVITY_REQUESTS.cancelAll()` 终止进行中的请求，并通过 `ANTIGRAVITY_SESSION_LOCK.reset()` 将 `active` 设为 `null`。
2. **记录取消 ID**：将当前活跃的 `activeResponseIds` 和 `activeRequests` 分别记录在内存 Map `RESET_CANCELLED_RESPONSE_IDS` 和 `RESET_CANCELLED_REQUEST_FINGERPRINTS` 中。
3. **拦截 stale 请求**：在请求入口，通过 `resetCancelledPreviousResponseFailure` 匹配 fingerprint 或 `previous_response_id`，命中则返回 `409`。

然而，存在以下**三个关键漏洞边界**导致重置后仍可自动续写：

* **漏洞 A：5 分钟 TTL 窗口过期 (The TTL Gap)**
  `RESET_CANCELLED_RESPONSE_TTL_MS` 被硬编码为 5 分钟（`5 * 60 * 1000`）。在重置 5 分钟后，过期记录会被清除。此时如果客户端重试发送带有原 `previous_response_id` 的请求，由于会话锁中的 `active` 已经为 `null`，锁管理器将通过以下逻辑：
  ```javascript
  if (!active) {
    active = createEntry();
    accepted += 1;
    return Promise.resolve(createLease(active));
  }
  ```
  直接允许其**创建新会话租约**，由于历史消息仍随请求体发送，大模型会继续在此前被取消的任务上“续写”执行。

* **漏洞 B：已释放会话无法被记录 (The Pre-release Gap)**
  如果一个长任务的活跃租约在重置前因为**空闲超时被收割**（如 `releaseIdleContinuation`）或**正常完成**（无 pending tool calls，`settleAntigravitySessionLease` 自动调用了 `lease.release()`），此时 `active` 已经为 `null`。
  由于重置时 `before.sessionLock?.activeResponseIds` 为空，相关的 `responseId` **不会**被填入 `RESET_CANCELLED_RESPONSE_IDS`。客户端后续带上该 `previous_response_id` 重试时，将成功绕过重置检查。

* **漏洞 C：单次会话最大轮数限制被重置绕过 (Continuation Limit Bypass)**
  在 `antigravity-session-lock.mjs` 中，当活跃会话续写达到上限时：
  ```javascript
  if (active.continuations >= maxContinuations) {
    continuationLimitReleased += 1;
    releaseEntry(active); // 此处会将 active 设为 null
    const error = new Error(`Antigravity session continuation limit reached...`);
    return Promise.reject(error);
  }
  ```
  `releaseEntry(active)` 会直接将 `active` 置为 `null`。虽然此次请求被拦截，但如果客户端在捕获异常后自动发起重试，由于 `active` 变成了 `null`，下一个请求在 `acquire` 时会命中 `if (!active)` 从而开启一个全新的 `active` 会话，续写计数器（`continuations`）归零，这使得 12 轮的上限形同虚设。

### 2. 重复成功写入后的续写检测失效 (Write-History Loop Disablement)

在 [adaptive-server.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs) 中，设计了防只读/检查死循环的拦截器 `blockRepeatedReadOnlyInspectionLoop`：
```javascript
function blockRepeatedReadOnlyInspectionLoop(args, codexName, originalRequest = {}, chatMessages = []) {
    ...
    const priorCommands = priorShellCommandCalls(originalRequest, chatMessages);
    if (priorCommands.some(command => commandLooksLikeWrite(command))) return args;
    ...
}
```
* **已证实事实**：如果历史消息中**任何一个**先前的命令被识别为写入操作（`commandLooksLikeWrite`，例如 `apply_patch`、`Set-Content` 等），该函数就会**直接返回**，完全停用对后续重复只读检查指令（如 `cat`、`ls`、`Get-ChildItem`）的拦截。
* **后果**：大模型在成功写入一次文件后，如果后续陷入对编译状态或测试结果的反复读取死循环，系统将不再进行拦截，导致请求一直自我自动续写，直到达到 12 轮的硬限制。

---

## 二、 推测与因果分析 (Speculations & Cause Analysis)

基于上述代码事实，我们对长任务续写循环的发生机制做出以下推测：

1. **客户端静默重试机制**：前端或代理网关在接收到非 200 响应（如会话锁忙 429、网络超时，或 409 limit 错误）时，可能会自动剥离某些敏感字段或重新发起请求。由于 TTL 限制或 Fingerprint 的哈希容易因轻微参数变化（例如加入 `x-codex-window-id` 的自增）而改变，服务器无法识别该请求是重试，从而为其分配了新的会话，造成自动续写。
2. **读写交替漏洞**：由于 `blockRepeatedReadOnlyInspectionLoop` 的写入排除设计过于宽泛，大模型只需在死循环中穿插一次极小的写入（比如 `touch` 或追加日志），或者读取已有的历史写入记录，就能够无限刷新只读限制，使自动续写无法被断路器终止。

---

## 三、 最小化修改建议 (Minimum Proposed Changes)

为解决上述问题，同时**必须保留正常同一对话多轮和不同文件的长项目能力**，建议在不改动核心架构的前提下，对相关函数进行如下最小化改进：

### 1. 解决只读拦截失效问题（针对 `blockRepeatedReadOnlyInspectionLoop`）

**修改策略**：将“全局存在写入即放行”改为“仅计算自上一次写入以来的只读检查次数”。这样既允许大模型在写入文件后进行正常的读取验证，又防止了验证阶段的无限只读死循环。

**代码建议** (在 `adaptive-server.mjs` 中)：
```diff
function blockRepeatedReadOnlyInspectionLoop(args, codexName, originalRequest = {}, chatMessages = []) {
     if (!/^(?:exec_command|shell_command|run_command)$/i.test(String(codexName || ""))) return args;
     let parsed = null;
     try { parsed = JSON.parse(args || "{}"); } catch { return args; }
     if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return args;
     const key = typeof parsed.command === "string" ? "command" : typeof parsed.cmd === "string" ? "cmd" : "";
     if (!key || (!commandLooksLikeRead(parsed[key]) && !commandLooksLikeListing(parsed[key]))) return args;

     const priorCommands = priorShellCommandCalls(originalRequest, chatMessages);
-    if (priorCommands.some(command => commandLooksLikeWrite(command))) return args;
+    // 仅查找最后一次写入命令之后的只读命令，防止在写入后陷入无限读取循环
+    const lastWriteIndex = priorCommands.findLastIndex(command => commandLooksLikeWrite(command));
+    const inspectionsSinceLastWrite = lastWriteIndex === -1
+        ? priorCommands.filter(command => commandLooksLikeRead(command) || commandLooksLikeListing(command))
+        : priorCommands.slice(lastWriteIndex + 1).filter(command => commandLooksLikeRead(command) || commandLooksLikeListing(command));

-    const inspections = priorCommands.filter(command => commandLooksLikeRead(command) || commandLooksLikeListing(command));
-    if (inspections.length < 6) return args;
-    const signatures = inspections.map(normalizedRepeatedCommand);
+    if (inspectionsSinceLastWrite.length < 6) return args;
+    const signatures = inspectionsSinceLastWrite.map(normalizedRepeatedCommand);
     const hasRepeat = new Set(signatures).size < signatures.length;
-    const hasBroadRecursiveListing = inspections.some(command => /\b(?:Get-ChildItem|gci|dir)\b[\s\S]*\s-Recurse\b/i.test(command));
+    const hasBroadRecursiveListing = inspectionsSinceLastWrite.some(command => /\b(?:Get-ChildItem|gci|dir)\b[\s\S]*\s-Recurse\b/i.test(command));
     if (!hasRepeat && !hasBroadRecursiveListing) return args;

     parsed[key] = "Write-Output 'Anti-Codex completed the inspection phase after detecting repeated read-only calls. Do not issue another read or listing command. Use the evidence already collected to create or edit the requested deliverable now, then verify it.'; exit 0";
     return JSON.stringify(parsed);
 }
```

### 2. 解决会话上限绕过问题（针对 `antigravity-session-lock.mjs`）

**修改策略**：当达到 `maxContinuations` 时，不要立刻销毁活跃会话（不调用 `releaseEntry`），而是将其标记为 `limitReached = true`。直到客户端显式发起 Fresh Turn（即不带匹配的 responseId/callId）或者锁超时，该状态才跟随会话销毁。这可以防止客户端通过连续重试立即获得新租约。

**代码建议** (在 `antigravity-session-lock.mjs` 中)：
```diff
   function acquire({ previousResponseId = "", continuationCallIds = [], signal } = {}) {
     if (signal?.aborted) return Promise.reject(abortReason(signal));
     const previousId = String(previousResponseId || "");
     const callIds = normalizeStringSet(continuationCallIds);
     const matchesActiveResponse = active && previousId && active.responseIds.has(previousId);
     const matchesActiveToolCall = active && callIds.size > 0 && intersects(active.callIds, callIds);

     if (matchesActiveResponse || matchesActiveToolCall) {
+      if (active.limitReached) {
+        const error = new Error(`Antigravity session continuation limit reached; this session is blocked. Start a fresh task turn.`);
+        error.name = "AntigravitySessionContinuationLimitError";
+        error.statusCode = 409;
+        error.retryable = false;
+        return Promise.reject(error);
+      }
       if (active.continuations >= maxContinuations) {
         continuationLimitReleased += 1;
-        releaseEntry(active);
+        active.limitReached = true; // 仅标记限制，不清除 active 状态，保持锁定
         const error = new Error(`Antigravity session continuation limit reached (${maxContinuations}); start a fresh task turn.`);
         error.name = "AntigravitySessionContinuationLimitError";
         error.statusCode = 409;
         error.type = "antigravity_session_continuation_limit";
         error.retryable = false;
         error.maxContinuations = maxContinuations;
         return Promise.reject(error);
       }
       active.continuations += 1;
       continued += 1;
       return Promise.resolve(createLease(active));
     }
```

---

## 四、 建议的验证测试 (Suggested Validation Tests)

可以在 `translator/tests/antigravity-session-lock.test.mjs` 中添加如下最小测试，验证限制不被重试绕过：

```javascript
test("Antigravity session lock blocks immediate retry after reaching continuation limit", async () => {
  const lock = createAntigravitySessionLock({ maxContinuations: 1 });
  const first = await lock.acquire();
  first.continueWith("resp_1");

  // 第一次续写，达到限制
  await assert.rejects(
    lock.acquire({ previousResponseId: "resp_1" }),
    (error) => error.name === "AntigravitySessionContinuationLimitError"
  );

  // 模拟客户端立即重试匹配的 response，应当仍然被拒绝，而不是创建新租约
  await assert.rejects(
    lock.acquire({ previousResponseId: "resp_1" }),
    (error) => error.name === "AntigravitySessionContinuationLimitError"
  );
});
```
