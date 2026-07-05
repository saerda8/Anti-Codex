# Xiaoqiang2 Real Mini Release Review

Marker: XQ2_REAL_MINI_RELEASE_REVIEW_20260706

- `latest-real-mini-tool` release-gate semantics can prove that the request side recorded requested real traffic and that the execution side recorded used real traffic.
- The evidence chain includes `first_response_id`, which can correlate the run with the first local model response observed by Anti-Codex.
- The evidence chain includes `call_id`, which can correlate the tool call and executor logs with the same local traffic request.
- Artifact evidence covers `exists`, `ran`, and `markerMatched`, proving the local product file existed, ran, and matched the expected marker.
- Executor evidence covers `tool` and `realFileWrite`, proving the executor tool path performed a real local file write.
- Final CLI success text can prove the local CLI path reached the expected success state.
- These release-gate fields prove local repository/request/execution semantics only. They do not prove external billing or provider quota dashboard decrement.
