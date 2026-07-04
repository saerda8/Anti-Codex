# Xiaoqiang2 ASCII MCP Skills Review

## Scope

Reviewed `scripts/test-anticodex-mcp-skills.ps1` only for the current ASCII xiaoqiang MCP integration. The review focused on whether `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3` are treated as real expected MCP servers and whether verifier output/failure handling fails when an expected xiaoqiang server or its DeepSeek MCP tool set is missing.

## Findings

- `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3` are explicit expected MCP servers. The script defines `$expectedXiaoqiangMcpNames = @("xiaoqiang1", "xiaoqiang2", "xiaoqiang3")` and computes `$missingXiaoqiangMcpNames` from the actual parsed MCP names in `config.toml`.
- All three xiaoqiang servers are also present in `$expectedMcpToolNames` with the required DeepSeek tool set: `deepseek_cancel_job`, `deepseek_get_job`, `deepseek_implement_in_workspace`, `deepseek_start_implementation`, `deepseek_tail_job`, and `deepseek_wait_for_job`.
- The script runs real stdio `tools/list` checks for every configured non-`node_repl` MCP server. For configured xiaoqiang servers, it compares returned tool names against the expected DeepSeek tool set and calls `Add-Failure` when any expected tool is missing.
- Missing xiaoqiang servers fail the verifier. If any of `xiaoqiang1`, `xiaoqiang2`, or `xiaoqiang3` is absent from the parsed MCP config, the script records `missing Xiaoqiang MCP servers: ...` through `Add-Failure`.
- The result and console summary expose the xiaoqiang status via `mcp.xiaoqiang.passed`, `mcp.xiaoqiang.expectedServers`, `mcp.xiaoqiang.missingServers`, per-server `checks`, plus console fields `xiaoqiangPassed` and `xiaoqiangMissingServers`.
- The final process outcome fails on any accumulated failure because the script exits with code `1` when `$failures.Count -gt 0`. This includes missing expected xiaoqiang servers and missing expected DeepSeek tools from any configured xiaoqiang server.

## Final Verdict

Confirmed. `scripts/test-anticodex-mcp-skills.ps1` treats `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3` as real expected MCP servers, requires each configured xiaoqiang server to expose the expected DeepSeek MCP tool set, reports the xiaoqiang pass/missing-server state in the summary, and fails the verifier when any expected xiaoqiang server or required DeepSeek tool is missing.
