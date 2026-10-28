# Freeze a process (every thread) — W2-3 gate fault "task hangs" without a switch in product code.
param([int]$ProcessId)
Add-Type -Namespace W2M3 -Name Nt -MemberDefinition @"
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
"@
$h = [W2M3.Nt]::OpenProcess(0x0800, $false, $ProcessId)
if ($h -eq [IntPtr]::Zero) { Write-Error "cannot open $ProcessId"; exit 1 }
exit [W2M3.Nt]::NtSuspendProcess($h)
