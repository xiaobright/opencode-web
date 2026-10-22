' Starts the tray with the web UI reachable from other devices on the same network.
' There is no login: anyone who can reach the port can use opencode and its tools, so use this only on
' a network you trust. See the "局域网访问" section in README.md.
'
'   start-lan.vbs          open the icon, the gateway and the browser
'   start-lan.vbs /lazy    icon and gateway only; opencode starts when the page is opened
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
lazy = ""
If WScript.Arguments.Named.Exists("lazy") Then lazy = " --lazy"
shell.CurrentDirectory = root
shell.Run "bun """ & root & "\scripts\tray.mjs"" --bind-host 0.0.0.0" & lazy, 0, False
