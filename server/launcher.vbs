' ShortScraping protocol dispatcher, invoked as: wscript.exe launcher.vbs "shortscraping://<action>"
' Registered by setup-launcher.bat for the shortscraping:// protocol.
' Security: only fixed-token matching below; the URL argument is NEVER
' concatenated into any command line. Unknown tokens exit silently.
Option Explicit

Dim shell, fso, scriptDir, arg
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count = 0 Then WScript.Quit 0
arg = LCase(WScript.Arguments(0))

If InStr(arg, "open-folder") > 0 Then
  shell.Run "explorer.exe """ & scriptDir & """", 1, False
ElseIf InStr(arg, "start-sync") > 0 Then
  ' 7 = minimized without stealing focus; start-sync.bat already guards
  ' against duplicate instances via its /health probe.
  shell.Run """" & scriptDir & "\start-sync.bat""", 7, False
End If
