# Xiaoqiang3 MCP/Skill Surface Review

Scope: review `scripts/test-anticodex-ecosystem-surfaces.mjs` for plugin, skill, MCP, and Xiaoqiang worker evidence that should be release-visible through `ecosystemSurfaces`.

## Covered in ecosystem surfaces

- Plugin/connectors: `latest-plugin-capabilities.json` is required through `pluginCapabilities`; it validates installed plugin inventory, connector inventory, connector parity, app-tool parity, and zero unauthorized app tools.
- Skills inventory: `latest-refresh-features.json` is required through `refreshFeatures`; it validates verify-only refresh output, clean connector/app-tool parity, MCP inventory count, and skill inventory count.
- Skill + MCP combined smoke: `latest-mcp-skills.json` is required through `mcpSkills`; it validates MCP smoke pass, Xiaoqiang summary pass, at least 11 MCP entries, skill inventory, and readable skill smoke.
- Xiaoqiang MCP inventory: `latest-xiaoqiang-mcp.json` is required through `xiaoqiangMcp`; it validates no-traffic semantics and explicit `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3` tool-list success with at least three tools each.
- Xiaoqiang worker project proof: `latest-xiaoqiang-worker-mcp-project-smoke.json` is required through `xiaoqiangWorkerProjectSmoke`; it validates real worker traffic, `xiaoqiang-project`, 3/3 Xiaoqiang workers, job ids, clean workspace verification, passing tests/CLI, and CLI JSON `red=2, blue=1`.
- Xiaoqiang worker complex proof: `latest-worker-mcp-complex-project-smoke.json` is required through `xiaoqiangWorkerComplexProjectSmoke`; it validates real worker traffic, `complex-project`, 3/3 Xiaoqiang workers, job ids, clean workspace verification, source validation, passing tests/CLI, `sourceCount=3`, report verification, and HTML verification.
- Worker MCP support surface: `latest-worker-mcp-source-hygiene.json`, `latest-worker-mcp-server-probe.json`, and `latest-worker-mcp-status-probe.json` are required through the worker MCP hygiene/probe/status entries.

## Not promoted as additional ecosystem-surface requirements

- `latest-worker-mcp-task-smoke.json` and `latest-worker-mcp-project-smoke.json` are high-value generic worker MCP evidence, but they are not Xiaoqiang-specific plugin/skill/MCP surface gaps. Goal-readiness already consumes those broader worker proofs, while the Xiaoqiang-specific ecosystem surface is covered by the dedicated `xiaoqiang-project` report and the scoped Xiaoqiang `complex-project` report.
- Desktop/UI complex-project reports are outside this plugin/skill/MCP/Xiaoqiang surface review and remain covered by the agentic/desktop readiness path, not this no-traffic ecosystem rollup.

## Verdict

No new script patch is required. The prior `xiaoqiangWorkerComplexProjectSmoke` entry closes the known high-value Xiaoqiang complex-project gap, and the remaining plugin, skill, MCP, Xiaoqiang MCP, and Xiaoqiang worker evidence is either already covered here or intentionally owned by broader readiness checks.
