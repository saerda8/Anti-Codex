root cause candidates:
1. Missing Timeout Parameter in client.connect()
   The client.connect(transport) call in scripts/test-anticodex-worker-mcp-task-smoke.mjs (line 521) is invoked without any options argument. Inside the MCP SDK Client.prototype.connect, the initialize request uses the default timeout of 60000ms (60s). If the OpenCode worker process takes longer than 60 seconds to complete its internal startup and respond to the initialize request, the connection times out on the client side with "MCP error -32001 Request timed out".

2. Incorrect Math.min Capping in rpcTimeoutMs Calculation
   The rpcTimeoutMs in scripts/test-anticodex-worker-mcp-task-smoke.mjs (line 503) is computed as Math.min(Math.max(config.startupTimeoutMs, 120000), Math.max(timeoutMs, 120000)). Since config.startupTimeoutMs is 90000, the left expression is 120000. The Math.min caps rpcTimeoutMs at 120000ms (120s) even when timeoutMs is 240000ms (240s). This limits the RPC request timeout budget to 2 minutes, cutting off slower workers early.

3. Spawning "git" throws synchronous/asynchronous EPERM
   In buildWorkerEnv inside opencode-worker-mcp.mjs, resolveExecutable("git") uses accessSync with F_OK to find "git", which can match a folder named "git" on PATH. Trying to spawn a directory throws EPERM in libuv (uv_spawn). If gitSummary or the worker process fails with EPERM and hangs or loops indefinitely, the wait/start tool call outlives the default 60s request timeout limit.

strongest evidence:
1. The error code -32001 corresponds to ErrorCode.RequestTimeout inside types.js. The default timeout of 60000ms (DEFAULT_REQUEST_TIMEOUT_MSEC) is applied directly inside protocol.js (line 712) whenever options.timeout is undefined. Since client.connect(transport) does not receive options, the initialize request uses 60s, triggering the exact 60s request timeout observed.
2. Mathematically, Math.min(Math.max(90000, 120000), Math.max(240000, 120000)) evaluates to Math.min(120000, 240000) which is 120000 (120s), proving the RPC timeout was capped at 120 seconds.
3. The previous log mentions EPERM uv_spawn 'git' which is standard behavior in Node.js when attempting to execute a directory on Windows.

recommended minimal fix:
1. Pass the rpcTimeoutMs option to client.connect in scripts/test-anticodex-worker-mcp-task-smoke.mjs:
   await withTimeout(client.connect(transport, { timeout: rpcTimeoutMs }), rpcTimeoutMs, `${workerName} connect`);
2. Change the Math.min to Math.max in the rpcTimeoutMs calculation:
   const rpcTimeoutMs = Math.max(Math.max(config.startupTimeoutMs, 120000), Math.max(timeoutMs, 120000));
3. Fix resolveExecutable in opencode-worker-mcp.mjs to verify that the resolved path is a file (using statSync(path).isFile()) and not a directory.

verification commands:
1. Run the specific scenario worker task smoke checks:
   node scripts/test-anticodex-worker-mcp-task-smoke.mjs --scenario complex-project --workers opencode-worker --worker-checks
2. Run git status to verify only the audit document is created/modified:
   git status --short
