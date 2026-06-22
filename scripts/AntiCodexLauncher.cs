using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Anti-Codex")]
[assembly: AssemblyDescription("Anti-Codex")]
[assembly: AssemblyProduct("Anti-Codex")]
[assembly: AssemblyCompany("Anti-Codex")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: ComVisible(false)]

public static class AntiCodexLauncher
{
    private const int DefaultLauncherTimeoutMs = 45000;

    public static int Main(string[] args)
    {
        string installRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string exeName = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName) ?? "";
        string scriptName = exeName.IndexOf("sync", StringComparison.OrdinalIgnoreCase) >= 0
            ? "sync-anticodex.ps1"
            : "start-anticodex.ps1";
        string script = Path.Combine(installRoot, "runtime", "scripts", scriptName);
        if (!File.Exists(script))
        {
            return 2;
        }

        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
        );
        if (!File.Exists(powershell)) powershell = "powershell.exe";

        var psi = new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script.Replace("\"", "\\\"") + "\"",
            WorkingDirectory = installRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        psi.EnvironmentVariables["DEEPCODEX_LAUNCHER_PID"] = Process.GetCurrentProcess().Id.ToString();

        using (Process child = Process.Start(psi))
        {
            if (child == null) return 3;
            int timeoutMs = DefaultLauncherTimeoutMs;
            string configuredTimeout = Environment.GetEnvironmentVariable("ANTICODEX_LAUNCHER_TIMEOUT_MS") ?? "";
            int parsedTimeout;
            if (int.TryParse(configuredTimeout, out parsedTimeout) && parsedTimeout > 0)
            {
                timeoutMs = parsedTimeout;
            }
            if (!child.WaitForExit(timeoutMs))
            {
                try { child.Kill(); } catch {}
                return 124;
            }
            return child.ExitCode;
        }
    }
}
