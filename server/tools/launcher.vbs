' ShortScraping protocol dispatcher, invoked as: wscript.exe launcher.vbs "shortscraping://<action>"
' Registered by setup-launcher.bat for the shortscraping:// protocol.
' Lives in server\tools\; both actions target the parent server\ folder,
' where the user-facing scripts (start-sync.bat / setup-launcher.bat) live.
' Security: only fixed-token matching below; the URL argument is NEVER
' concatenated into any command line. Unknown tokens exit silently.
Option Explicit

Dim shell, fso, serverDir, arg
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
serverDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

If WScript.Arguments.Count = 0 Then WScript.Quit 0
arg = LCase(WScript.Arguments(0))

If InStr(arg, "open-folder") > 0 Then
  shell.Run "explorer.exe """ & serverDir & """", 1, False
ElseIf InStr(arg, "start-sync") > 0 Then
  ' 7 = minimized without stealing focus; start-sync.bat already guards
  ' against duplicate instances via its /health probe.
  shell.Run """" & serverDir & "\start-sync.bat""", 7, False
End If
