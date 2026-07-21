# Stage 7 post-context native patch proof

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` and the same project directory:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

This is a bounded regression after raising the third-party context window to the native Codex baseline. Do not create another task or window, switch providers, restart either Codex client, rebuild media, change existing production files, or call any of the nine development MCP workers.

Use the provided native structured `apply_patch` function tool directly exactly once to add:

`qa\third-party-native-patch-post-context.txt`

Its only line must be:

`STAGE7_POST_CONTEXT_NATIVE_PATCH_OK_20260719`

Do not invoke `apply_patch` through `exec_command`, `shell_command`, PowerShell, cmd.exe, Bash, Node.js, Python, or another command wrapper. After the structured patch succeeds, use at most one read-only command to verify the file. Do not edit any other file.

End the final response with `STAGE7_POST_CONTEXT_NATIVE_PATCH_OK_20260719`.
