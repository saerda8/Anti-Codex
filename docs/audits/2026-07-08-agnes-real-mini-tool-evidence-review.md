# Anti-Codex Real Mini Tool Evidence Review - 2026-07-08

This is a side review record from Agnes Worker, rewritten by the main agent
after direct inspection because the first worker output was mojibake.

## evidence

- Real verifier: `test-anticodex-real-mini-tool.ps1 -AllowRealTraffic`.
- Result: `ok:true`, `usedRealTraffic:true`, `failures:[]`.
- Model: `gemini-3.5-flash-low`.
- Response id: `chatcmpl_ac995415b1c444a3a2711b6fad5b5b8f`.
- Tool call id: `pseudo_1783522682733_0`.
- Local artifact existed, ran, and matched marker `MINI_TOOL_MARKER_20260708-225744`.
- Route ledger contained the same response id at `2026-07-08T14:58:02.730Z`,
  transport `desktop-cascade`, status `success`.

## limits

This proves a fresh local Anti-Codex model route and tool-artifact execution.
It does not prove external provider quota or billing decrement. Provider-side
quota proof would require provider dashboard/API/billing evidence captured before
and after the run.

## next check

For a stronger product acceptance pass, run one small visible desktop coding
task and correlate its report with model-request or route evidence. Keep
provider quota proof separate unless provider-side data is available.
