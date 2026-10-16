' Starts the opencode-web tray: the icon, the local web UI and the browser, all hidden behind it.
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Run "bun """ & root & "\scripts\tray.mjs""", 0, False
