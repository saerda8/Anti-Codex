import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_PATHS = {
  launcherMain: "apps/codex-plus-launcher/src/main.rs",
  launcherCargo: "apps/codex-plus-launcher/Cargo.toml",
  launcherBin: "apps/codex-plus-launcher/src/anticodex-helper.rs",
  managerMain: "apps/codex-plus-manager/src-tauri/src/main.rs",
  managerCommands: "apps/codex-plus-manager/src-tauri/src/commands.rs",
  managerLib: "apps/codex-plus-manager/src-tauri/src/lib.rs",
  autoTakeover: "apps/codex-plus-manager/src-tauri/src/auto_takeover.rs",
  appPaths: "crates/codex-plus-core/src/app_paths.rs",
  codexHome: "crates/codex-plus-core/src/codex_home.rs",
  launcher: "crates/codex-plus-core/src/launcher.rs",
  paths: "crates/codex-plus-core/src/paths.rs",
  protocolProxy: "crates/codex-plus-core/src/protocol_proxy.rs",
  relayConfig: "crates/codex-plus-core/src/relay_config.rs",
  ports: "crates/codex-plus-core/src/ports.rs",
  watcher: "crates/codex-plus-core/src/watcher.rs",
  windowsIntegration: "crates/codex-plus-core/src/windows_integration.rs",
};

async function readRequiredSource(root, relativePath, optional = false) {
  try {
    return await fs.readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return "";
    throw new Error(`CodexPlusPlus source file missing: ${relativePath}`, { cause: error });
  }
}

function check(id, ok, summary, blocker) {
  return { id, ok, summary, ...(ok || !blocker ? {} : { blocker }) };
}

function quotedEnd(source, start) {
  const raw = source.slice(start).match(/^r(#{0,16})"/);
  if (raw) {
    const end = source.indexOf(`"${raw[1]}`, start + raw[0].length);
    return end < 0 ? source.length : end + 1 + raw[1].length;
  }
  if (source[start] === '"') {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index++] === '"') break;
    }
    return index;
  }
  if (source[start] === "'") {
    const character = source.slice(start).match(/^'(?:\\.|[^'\\])'/s);
    if (character) return start + character[0].length;
  }
  return start;
}

function stripRustComments(source) {
  const output = source.split("");
  for (let index = 0; index < source.length;) {
    const quoted = quotedEnd(source, index);
    if (quoted > index) { index = quoted; continue; }
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") output[index++] = " ";
    } else if (source.startsWith("/*", index)) {
      let depth = 1;
      output[index++] = " "; output[index++] = " ";
      while (index < source.length && depth) {
        if (source.startsWith("/*", index)) { depth++; output[index++] = " "; output[index++] = " "; }
        else if (source.startsWith("*/", index)) { depth--; output[index++] = " "; output[index++] = " "; }
        else { if (source[index] !== "\n") output[index] = " "; index++; }
      }
    } else index++;
  }
  return output.join("");
}

function maskRustStrings(source) {
  const output = source.split("");
  for (let index = 0; index < source.length;) {
    const end = quotedEnd(source, index);
    if (end > index) {
      while (index < end) { if (source[index] !== "\n") output[index] = " "; index++; }
    } else index++;
  }
  return output.join("");
}

function rustBlock(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const quoted = quotedEnd(source, index);
    if (quoted > index) { index = quoted - 1; continue; }
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  return "";
}

function rustFunction(source, name, publicOnly = false) {
  const visibility = publicOnly ? "pub(?:\\([^)]*\\))?\\s+" : "(?:pub(?:\\([^)]*\\))?\\s+)?";
  const matcher = new RegExp(`(?:^|\\n)[ \\t]*${visibility}(?:async\\s+)?fn\\s+${name}\\b`, "g");
  for (let match; (match = matcher.exec(source));) {
    const open = source.indexOf("{", matcher.lastIndex);
    const semicolon = source.indexOf(";", matcher.lastIndex);
    if (open < 0) return "";
    if (semicolon >= 0 && semicolon < open) continue;
    return rustBlock(source, open);
  }
  return "";
}

const compact = (value) => value.replace(/\s+/g, "");
function ordered(source, ...tokens) {
  let cursor = 0;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor);
    if (next < 0) return false;
    cursor = next + token.length;
  }
  return true;
}

function isolatedStopBranch(source) {
  const match = /if\s+let\s+Some\(path\)\s*=\s*isolated_app_path\s*\{/.exec(source);
  if (!match) return "";
  return rustBlock(source, match.index + match[0].lastIndexOf("{"));
}

function branchBody(source, pattern) {
  const match = pattern.exec(source);
  return match ? rustBlock(source, match.index + match[0].lastIndexOf("{")) : "";
}

function rustImpl(source, name) {
  const match = new RegExp(`\\bimpl\\s+${name}\\s*\\{`).exec(source);
  return match ? rustBlock(source, match.index + match[0].lastIndexOf("{")) : "";
}

function modernIsolationChecks(source) {
  const clean = Object.fromEntries(["launcherMain", "managerCommands", "managerLib", "launcher", "appPaths", "watcher", "windowsIntegration"]
    .map((key) => [key, stripRustComments(source[key])]));
  const code = Object.fromEntries(Object.entries(clean).map(([key, value]) => [key, maskRustStrings(value)]));
  const fn = (file, name) => rustFunction(code[file], name);
  const start = compact(fn("launcherMain", "start"));
  const session = compact(fn("launcherMain", "launcher_session"));
  const validateBranch = compact(branchBody(fn("launcherMain", "validate_isolated_app_path"),
    /\bif\s+(?:[\w:]+::)?(?:validate_isolated_environment\(\)\?|isolated_instance_mode\(\))\s*\{/));
  const managerStart = compact(fn("managerCommands", "start_embedded_launcher_with"));
  const managerValidate = compact(fn("managerCommands", "validate_isolated_launch_app_path"));
  const launch = compact(fn("launcher", "launch_and_inject_with_hooks"));
  const launchBranch = compact(branchBody(fn("launcher", "launch_and_inject_with_hooks"), /\bif\s+isolated\s*\{/));
  const build = compact(fn("appPaths", "build_codex_executable"));
  const explicit = compact(fn("appPaths", "explicit_codex_executable"));
  const configured = compact(fn("appPaths", "configured_codex_executable_from_value"));
  const validateCopy = compact(fn("appPaths", "validate_isolated_copied_app_dir_against"));
  const validateCopyRaw = compact(rustFunction(clean.appPaths, "validate_isolated_copied_app_dir_against"));
  const compare = compact(fn("watcher", "same_isolated_executable"));
  const visibility = compact(fn("watcher", "ensure_isolated_processes_visible"));
  const snapshot = compact(fn("watcher", "find_isolated_processes_from_snapshot"));
  const find = compact(fn("watcher", "find_codex_processes_for_app_path"));
  const stop = compact(fn("watcher", "stop_codex_processes_and_wait_for_app_path"));
  const debugOwner = compact(fn("watcher", "find_codex_processes_for_app_path_and_debug_port"));
  const captureListener = compact(fn("windowsIntegration", "capture_debug_listener"));
  const trackedCapture = compact(rustFunction(rustImpl(code.windowsIntegration, "TrackedWindowsProcess"), "capture"));
  const restart = compact(fn("managerCommands", "restart_codex_plus_blocking"));
  const managerStop = compact(fn("managerCommands", "stop_codex_plus_blocking"));
  const stopBranch = compact(isolatedStopBranch(fn("managerCommands", "stop_main_codex_process")));
  const focus = compact(fn("managerLib", "focus_existing_manager_window"));
  const focusCompare = compact(fn("managerLib", "same_windows_executable_path"));
  const activate = compact(fn("launcherMain", "activate_existing_codex_app"));
  const stopRuntime = compact(rustFunction(code.launcherMain, "stop", true));
  const runtimeLoop = compact(fn("launcherMain", "runtime_commands"));
  const runtimeStopBranch = compact(branchBody(fn("launcherMain", "runtime_commands"), /Some\(RuntimeCommand::Stop\(reply\)\)\s*=>\s*\{/));

  const processScope = compare.includes("to_string_lossy()") && compare.includes("to_ascii_lowercase()")
    && compare.includes("normalize(left)==normalize(right)")
    && visibility.includes("anyhow::ensure!(!processes.iter().any(|p|p.exe_file.eq_ignore_ascii_case(&name)&&p.executable_path.is_none())")
    && snapshot.includes("process.executable_path.as_deref().is_some_and(|path|same_isolated_executable(path,executable))")
    && ordered(find, "validate_isolated_copied_app_dir(target_app_path)?", "build_codex_executable(target_app_path)", "ensure_isolated_processes_visible(", "find_isolated_processes_from_snapshot(")
    && /Ok\(find_isolated_processes_from_snapshot\(&snapshot,&executable,?\)\)/.test(find)
    && !find.includes("find_codex_processes()")
    && ordered(stop, "validate_isolated_copied_app_dir(target_app_path)?", "build_codex_executable(target_app_path)", "ensure_isolated_processes_visible(", "VerifiedStopProcess::capture(", "same_isolated_executable(&handle.image()?,&executable)", "handle.terminate()?", ".is_alive()?");
  const verifiedStop = stop.includes("if!process.executable_path.as_deref().is_some_and(|path|same_isolated_executable(path,&executable)){continue;}")
    && stop.includes("if!same_isolated_executable(&handle.image()?,&executable){continue;}");
  const verifiedDebugOwner = ordered(debugOwner, "validate_isolated_copied_app_dir(target_app_path)?", "build_codex_executable(target_app_path)", "capture_debug_listener(debug_port,&executable)?", "loopback_listener_process_ids(debug_port)?.is_empty()", "owner.is_alive()?", "Ok(vec![owner.process_id])")
    && ordered(captureListener, "unique_listener_process_id(&loopback_listener_process_ids(port)?)?", "TrackedWindowsProcess::capture(pid,executable)?", "ifunique_listener_process_id(&loopback_listener_process_ids(port)?)?!=Some(pid){returnOk(None);}", "Ok(Some(process))")
    && ordered(trackedCapture, "OwnedHandle::from_raw_handle(", "QueryFullProcessImageNameW(", "ifnormalize(&actual)!=normalize(&expected){returnOk(None);}", "GetProcessTimes(", "Ok(Some(Self{");

  const alternate = ordered(managerStart, "validate_isolated_launch_app_path(request)?", "codex_plus_launcher::start(")
    && managerStart.includes("app_dir:(!request.app_path.trim().is_empty()).then(||PathBuf::from(request.app_path.trim()))")
    && managerStart.includes("replace_blocking_main_instance:replace_blocking_main_instance&&!isolated")
    && ordered(start, "validate_isolated_app_path(options.app_dir.as_deref())?", "RuntimeCommand::Start(options,")
    && ordered(validateBranch, ".ok_or_else(", "validate_isolated_copied_app_dir(")
    && session.includes("launch_and_inject_with_hooks(options,hooks)")
    && ordered(launchBranch, "options.app_dir.as_deref()", "validate_isolated_copied_app_dir(")
    && ordered(launch, "validate_isolated_environment()?", "options.app_dir.as_deref()", "validate_isolated_copied_app_dir(", "hooks.resolve_app_dir(options.app_dir.as_deref(),&settings)");

  const executable = source.appPaths.includes("CODEX_PLUS_APP_EXECUTABLE")
    && explicit.includes("!executable.is_absolute()") && explicit.includes("!executable.is_file()")
    && explicit.includes("canonical_executable.parent()==Some(canonical_app_dir.as_path())")
    && configured.includes("Some(explicit_codex_executable(app_dir,value).unwrap_or_default())")
    && ordered(build, "configured_codex_executable(app_dir)", "returnexecutable;", "executable_in_dir(app_dir)")
    && validateCopy.includes("eq_ignore_ascii_case()")
    && validateCopyRaw.includes('eq_ignore_ascii_case("Anti-Codex.exe")')
    && validateCopy.includes("exact_app_path_matches(app_dir,configured_app_dir)")
    && validateCopy.includes("reject_symlink_components(app_dir)?")
    && validateCopy.includes("reject_symlink_components(configured_executable)?")
    && processScope && verifiedStop;

  const scopedStop = ordered(stopBranch, "stop_codex_processes_and_wait_for_app_path(path)?", "returnOk(())");
  const managerUsesScopedStop = (body) => ordered(body, "validate_isolated_launch_app_path(&request)", "stop_main_codex_process(request.debug_port,target_app_path.as_deref())", "codex_plus_launcher::stop");
  const currentManagerFocus = focus.includes("std::env::current_exe().ok()")
    && /\.any\(\|name\|process\.exe_file\.eq_ignore_ascii_case\(name\)\)&&current_executable\.as_deref\(\)\.is_some_and\(\|current\|\{?process\.executable_path\.as_deref\(\)\.is_some_and\(\|path\|same_windows_executable_path\(path,current\)\)\}?\)&&[\w:]*windows_activate_process_window\(process\.process_id\)/.test(focus)
    && focusCompare.includes("to_string_lossy()") && focusCompare.includes("to_ascii_lowercase()")
    && focusCompare.includes("normalize(left)==normalize(right)");
  const scoped = processScope && verifiedStop && verifiedDebugOwner && alternate && managerValidate.includes("validate_isolated_copied_app_dir(&path)?")
    && scopedStop && managerUsesScopedStop(restart) && managerUsesScopedStop(managerStop)
    && stopRuntime.includes("send_runtime_command(RuntimeCommand::Stop)")
    && runtimeLoop.includes("Some(RuntimeCommand::Stop(reply))") && runtimeStopBranch.includes("session.take()") && runtimeStopBranch.includes("current.stop().await")
    && ordered(activate, "validate_isolated_app_path(options.app_dir.as_deref())?", "isolated_instance_mode()", "find_codex_processes_for_app_path(&app_dir)?")
    && /letprocess_ids=if[\w:]*isolated_instance_mode\(\)\{[\w:]*find_codex_processes_for_app_path\(&app_dir\)\?\}else\{[\w:]*find_codex_processes\(\)\}/.test(activate)
    && ordered(launch, "ifisolated&&", "find_codex_processes_for_app_path_and_debug_port(", ".launch_codex(", "ifisolated{", "loop{", "find_codex_processes_for_app_path_and_debug_port(", ".ensure_injection(")
    && currentManagerFocus;
  return { alternate, executable, scoped };
}

export async function auditCodexPlusPlusIsolation(root) {
  const source = Object.fromEntries(
    await Promise.all(
      Object.entries(SOURCE_PATHS).map(async ([key, relativePath]) => [
        key,
        await readRequiredSource(root, relativePath, ["autoTakeover", "windowsIntegration", "launcherCargo", "launcherBin", "managerMain"].includes(key)),
      ]),
    ),
  );
  const fixedProtocolProxyConsumers = [
    source.managerCommands,
    source.managerLib,
    source.launcher,
    source.relayConfig,
  ].filter((contents) => contents.includes("protocol_proxy::DEFAULT_PROTOCOL_PROXY_PORT"));
  const hardcodedHelperPortDefault =
    /fn default_(?:dream_skin_)?helper_port\(\) -> u16 \{\s*57321\s*\}/.test(
      source.managerCommands,
    );
  const modernLayout = Boolean(
    rustFunction(maskRustStrings(stripRustComments(source.managerCommands)), "start_embedded_launcher_with")
      || rustFunction(maskRustStrings(stripRustComments(source.managerCommands)), "stop_main_codex_process")
      || rustFunction(maskRustStrings(stripRustComments(source.watcher)), "find_isolated_processes_from_snapshot"),
  );
  const modern = modernLayout ? modernIsolationChecks(source) : null;
  const binTables = source.launcherCargo.split(/^\s*(?=\[)/m);
  const configuredBin = binTables.some((table) => /^\[\[bin\]\]/.test(table)
    && /^\s*name\s*=\s*"codex-plus-plus"\s*$/m.test(table)
    && /^\s*path\s*=\s*"src\/anticodex-helper\.rs"\s*$/m.test(table));
  const binClean = stripRustComments(source.launcherBin);
  const binCode = maskRustStrings(binClean);
  const binParse = compact(rustFunction(binClean, "parse_args"));
  const binRun = rustFunction(binCode, "run");
  const binHelperPort = compact(rustFunction(binCode, "validate_helper_port_for_isolation"));
  const helperBranch = compact(branchBody(binRun, /\bif\s+args\.helper_only\s*\{/));
  const desktopBranch = compact(branchBody(binRun, /\}\s*else\s*\{/));
  const modernBin = configuredBin
    && binParse.includes('"--helper-only"=>result.helper_only=true')
    && binParse.includes('"--app-path"=>{result.app_dir=Some(PathBuf::from(')
    && binParse.includes("ifresult.helper_only==result.app_dir.is_some(){returnErr(")
    && binParse.includes("result.helper_port_explicit=true")
    && binHelperPort.includes("ifisolated&&args.helper_only&&!args.helper_port_explicit{returnErr(")
    && ordered(compact(binRun), "parse_args(args)", "validate_isolated_environment()?", "validate_helper_port_for_isolation(&args,isolated)", "ifargs.helper_only{")
    && helperBranch.includes("resident_helper::ensure_resident_helper(args.helper_port)?")
    && ordered(desktopBranch, "validate_isolated_protocol_proxy_port(true)?", "codex_plus_launcher::start(");
  const pathsCode = stripRustComments(source.paths);
  const managerCode = maskRustStrings(stripRustComments(source.managerMain));
  const managerEntry = rustFunction(managerCode, "main");
  const managerPortError = compact(branchBody(managerEntry,
    /\bif\s+let\s+Err\(error\)\s*=\s*(?:[\w:]+::)?validate_isolated_protocol_proxy_port\(true\)\s*\{/));
  const launcherEntry = rustFunction(maskRustStrings(stripRustComments(source.launcher)), "launch_and_inject_with_hooks");
  const launcherIsolation = compact(branchBody(launcherEntry, /\bif\s+isolated\s*\{/));
  const environmentValidation = compact(rustFunction(pathsCode, "validate_isolated_environment"));
  const portValidation = compact(rustFunction(pathsCode, "validate_protocol_proxy_port_value"));
  const requiredValidation = compact(rustFunction(pathsCode, "validate_isolated_protocol_proxy_port"));
  const modernPortGuards = !modernLayout || (
    managerPortError.includes("std::process::exit(1)")
    && ordered(compact(managerEntry), "validate_isolated_protocol_proxy_port(true)", "codex_plus_manager_lib::run()")
    && launcherIsolation.includes("validate_isolated_protocol_proxy_port(true)?")
    && /validate_protocol_proxy_port_value\(true,std::env::var_os\("CODEX_PLUS_PROTOCOL_PROXY_PORT"\)\.as_deref\(\),false,?\)\?/.test(environmentValidation)
    && portValidation.includes("if!isolated||(value.is_none()&&!required){returnOk(());")
    && portValidation.includes(".parse::<u16>().ok()") && portValidation.includes(".is_some_and(|port|port!=0)")
    && /validate_isolated_environment\(\)\?,std::env::var_os\("CODEX_PLUS_PROTOCOL_PROXY_PORT"\)\.as_deref\(\),required,?\)/.test(requiredValidation)
  );
  const modernPorts = !modernLayout || (
    compact(rustFunction(maskRustStrings(stripRustComments(source.managerCommands)), "default_helper_port"))
      .includes("protocol_proxy::protocol_proxy_port()")
    && compact(rustFunction(maskRustStrings(stripRustComments(source.managerCommands)), "default_dream_skin_helper_port"))
      .includes("protocol_proxy::protocol_proxy_port()")
    && compact(rustFunction(rustImpl(maskRustStrings(stripRustComments(source.launcher)), "Default\\s+for\\s+LaunchOptions"), "default"))
      .includes("helper_port:crate::protocol_proxy::protocol_proxy_port()")
    && compact(rustFunction(maskRustStrings(stripRustComments(source.autoTakeover)), "spawn_takeover"))
      .includes("protocol_proxy::protocol_proxy_port()")
  );

  const checks = [
    check(
      "alternate_app_path",
      modernLayout ? modern.alternate && modernBin : source.launcherMain.includes("--app-path")
        && source.launcherMain.includes("options.app_dir.as_deref()"),
      "Launcher accepts and resolves an explicit copied application path.",
      "The launcher cannot be pinned to the copied Anti-Codex application.",
    ),
    check(
      "explicit_copied_executable",
      modernLayout ? modern.executable : source.appPaths.includes("CODEX_PLUS_APP_EXECUTABLE")
        && source.appPaths.includes("configured_codex_executable")
        && source.appPaths.includes("explicit_codex_executable")
        && source.appPaths.includes("canonical_executable.parent()")
        && source.appPaths.includes("Some(explicit_codex_executable(app_dir, value).unwrap_or_default())")
        && source.watcher.includes("find_codex_processes_from_snapshot_for_executable")
        && source.watcher.includes("build_codex_executable(target_app_path)"),
      "The copied application can select its branded executable and scope process discovery to it.",
      "The copied directory can fall back to ChatGPT.exe or share process scope with another executable.",
    ),
    check(
      "isolated_codex_home",
      source.codexHome.includes('var_os("CODEX_HOME")'),
      "Codex configuration and session state can use an explicit CODEX_HOME.",
      "Codex state would fall back to the original user profile.",
    ),
    check(
      "inherited_child_environment",
      source.launcher.includes("Command::new(executable)")
        && source.launcher.includes(".spawn()")
        && !source.launcher.includes(".env_clear()"),
      "The copied application inherits the isolated parent environment.",
      "The launcher clears the environment required for isolated Codex state.",
    ),
    check(
      "isolated_guard_port",
      source.ports.includes("CODEX_PLUS_LAUNCHER_GUARD_PORT"),
      "The launcher single-instance guard port is independently configurable.",
      "The Anti-Codex launcher could collide with another CodexPlusPlus launcher.",
    ),
    check(
      "isolated_state_dir",
      source.paths.includes("CODEX_PLUS_STATE_DIR"),
      "CodexPlusPlus settings, logs and locks have an explicit state root.",
      "CodexPlusPlus state is fixed to the user's shared .codex-session-delete directory.",
    ),
    check(
      "isolated_protocol_proxy_port",
      source.protocolProxy.includes("CODEX_PLUS_PROTOCOL_PROXY_PORT"),
      "The Chat/Responses protocol proxy port is independently configurable.",
      "The protocol proxy is fixed to one process-wide port and cannot coexist independently.",
    ),
    check(
      "isolated_protocol_proxy_consumers",
      fixedProtocolProxyConsumers.length === 0 && !hardcodedHelperPortDefault && modernPorts && modernPortGuards,
      "Every runtime protocol-proxy consumer resolves the isolated port.",
      "A runtime protocol-proxy consumer still bypasses CODEX_PLUS_PROTOCOL_PROXY_PORT.",
    ),
    check(
      "target_scoped_process_watcher",
      modernLayout ? modern.scoped : source.watcher.includes("find_codex_processes_for_app_path")
        && source.watcher.includes("target_app_path")
        && source.launcherMain.includes("find_codex_processes_for_app_path")
        && source.launcherMain.includes("validate_isolated_app_path")
        && source.launcherMain.includes("isolated_instance_mode")
        && source.launcher.includes("find_codex_processes_for_app_path")
        && source.managerCommands.includes("stop_launcher_processes_and_wait_for_path")
        && source.managerCommands.includes("stop_codex_processes_and_wait_for_app_path")
        && source.managerCommands.includes("validate_isolated_launch_app_path")
        && source.managerLib.includes("same_windows_executable_path")
        && source.managerLib.includes("std::env::current_exe()")
        && source.managerLib.includes("process.executable_path"),
      "Process discovery, activation, waiting and restart are scoped to the copied application.",
      "An isolated launcher or manager can still fall back to, activate, inspect, wait for or stop an unrelated Codex path.",
    ),
    check(
      "isolated_watcher_registration",
      source.watcher.includes("isolated_instance_watcher_disabled"),
      "The isolated build refuses global logon-watcher installation and removal.",
      "The isolated build can still modify the shared current-user logon watcher or shortcut.",
    ),
  ];

  const blockers = checks
    .filter((item) => !item.ok)
    .map((item) => ({ id: item.id, message: item.blocker }));

  return {
    compatibilityReady: blockers.length === 0,
    root: path.resolve(root),
    checks,
    blockers,
  };
}
