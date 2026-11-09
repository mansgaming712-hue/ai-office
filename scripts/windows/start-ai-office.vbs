' Peluncur tersembunyi AI Office.
' Dipanggil oleh shortcut "AI Office" di folder Startup Windows (dibuat install-autostart.ps1).
' Menjalankan ai-office-supervisor.ps1 lewat PowerShell tanpa jendela (window style 0), lalu langsung selesai.
' Argumen opsional: path absolut node.exe yang ditemukan saat instalasi.
Option Explicit
Dim fso, sh, scriptDir, ps1, psExe, nodePath, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "ai-office-supervisor.ps1")
psExe = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

nodePath = ""
If WScript.Arguments.Count > 0 Then nodePath = WScript.Arguments(0)

cmd = """" & psExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
If nodePath <> "" Then cmd = cmd & " -NodePath """ & nodePath & """"

' 0 = tanpa jendela, False = jangan tunggu (supervisor berjalan terus di latar belakang).
sh.Run cmd, 0, False
