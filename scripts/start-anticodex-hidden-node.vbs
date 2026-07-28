Option Explicit

If WScript.Arguments.Count <> 2 Then
    WScript.Quit 64
End If

Dim shell, command, exitCode
Set shell = CreateObject("WScript.Shell")
command = QuoteArgument(WScript.Arguments(0)) & " " & QuoteArgument(WScript.Arguments(1)) & " --hide-console"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
