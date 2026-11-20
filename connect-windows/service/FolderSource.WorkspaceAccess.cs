using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace PackProof.Connect;

public static partial class FolderSource
{
    public const int MaxCsvBytes = 2 * 1024 * 1024;
    private const uint OpenExisting = 3, OpenReparse = 0x00200000, BackupSemantics = 0x02000000;
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPath(SafeFileHandle handle, [Out] char[] path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    private static string Final(SafeFileHandle h) { var chars = new char[32768]; var n = GetFinalPath(h, chars, (uint)chars.Length, 0); if (n == 0 || n >= chars.Length) throw Error(); var name = new string(chars, 0, (int)n); return name.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) ? @"\\" + name[8..] : name.StartsWith(@"\\?\", StringComparison.Ordinal) ? name[4..] : name; }
    private static ConnectException Error() => new("SOURCE_ACCESS_DENIED", "The background collector cannot read this shipment folder. Choose the prepared PackProof Exports folder, or have the source owner grant this specific service read/list access to a dedicated local NTFS folder. Your protected storage and queued records have not been reset.");
    internal static string ValidateCore(string input, bool allowShare, bool checkListing = true)
    {
        if (!OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(input) || input.Length > 260 || (input.StartsWith(@"\\") && (!allowShare || input.StartsWith(@"\\?\") || input.StartsWith(@"\\.\"))) || input.IndexOf(':', 2) >= 0 || !Path.IsPathFullyQualified(input)) throw Error();
        var path = Path.GetFullPath(input).TrimEnd(Path.DirectorySeparatorChar); var root = Path.GetPathRoot(path)!; var share = path.StartsWith(@"\\", StringComparison.Ordinal);
        if (!allowShare && share) throw Error();
        if (path.Equals(root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) || share && root.TrimEnd(Path.DirectorySeparatorChar).EndsWith('$')) throw Error();
        var drive = share ? null : new DriveInfo(root);
        if (drive is not null && (drive.DriveType != DriveType.Fixed || !drive.DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase))) throw Error();
        var blocked = new[] { Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PackProof", "Connect") };
        if (blocked.Where(x => x.Length > 0).Any(x => path.Equals(x, StringComparison.OrdinalIgnoreCase) || path.StartsWith(x + "\\", StringComparison.OrdinalIgnoreCase))) throw Error();
        for (var node = new DirectoryInfo(path); node is not null; node = node.Parent) if ((node.Attributes & FileAttributes.ReparsePoint) != 0) throw Error();
        using var h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero); if (h.IsInvalid || !Final(h).Equals(path, StringComparison.OrdinalIgnoreCase)) throw Error();
        if (checkListing) _ = Directory.EnumerateFiles(path).Take(1).ToArray();
        return path;
    }
    internal static FileStream OpenVerifiedFile(string path)
    {
        var handle = CreateFile(path, 0x80000000, 1, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero);
        try
        {
            if (handle.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                if (error is 32 or 33) throw new IOException("Source is busy.", new Win32Exception(error));
                throw Error();
            }
            if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Offline)) != 0 || info.Links != 1 || !Final(handle).Equals(path, StringComparison.OrdinalIgnoreCase)) throw Error();
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }
}
