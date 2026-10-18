' Starts only the resident tray and web gateway; OpenCode starts when the page opens.
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
bun = shell.ExpandEnvironmentStrings("%USERPROFILE%\.bun\bin\bun.exe")
If Not files.FileExists(bun) Then bun = "bun"
shell.Run """" & bun & """ """ & root & "\scripts\tray.mjs"" --lazy", 0, False
