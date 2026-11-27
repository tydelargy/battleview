' Battle Map for Windows: start the server hidden and open the browser. If it is already running, the second start
' just opens the browser (battlemap.js notices the port is taken by a Battle Map and does exactly that).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run """" & dir & "\node.exe"" """ & dir & "\app\bin\battlemap.js"" --hub --open", 0, False
