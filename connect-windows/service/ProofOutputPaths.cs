using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace PackProof.Connect;

// Open ordinary directory handles without delete sharing while comparing
// physical IDs. An alias (8.3 name, UNC alias or alternate share) can otherwise
// evade an ordinary full-path prefix test.
internal static class ProofOutputPaths
{
    private static ConnectException UnsafePath() => new("OUTPUT_PATH_UNSAFE",
        "Choose a dedicated proof folder outside the source, PackProof storage, and system folders. Links and mapped drives cannot be used.");

    internal static string Normalize(string input)
    {
        if (string.IsNullOrWhiteSpace(input) || !Path.IsPathFullyQualified(input) || input.Length > 2048 ||
            input.StartsWith(@"\\?\", StringComparison.Ordinal) || input.StartsWith(@"\\.\", StringComparison.Ordinal))
            throw UnsafePath();
        var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(input));
        if (path == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(path)!)) throw UnsafePath();
        if (OperatingSystem.IsWindows() && (path.IndexOf(':', 2) >= 0 ||
            path.Split('\\').Any(s => s.EndsWith('.') || s.EndsWith(' ') || s.EndsWith('$')) ||
            (!path.StartsWith(@"\\", StringComparison.Ordinal) && new DriveInfo(Path.GetPathRoot(path)!).DriveType != DriveType.Fixed)))
            throw UnsafePath();
        return path;
    }

    internal static bool Overlaps(string a, string b)
    {
        a = Path.TrimEndingDirectorySeparator(Path.GetFullPath(a));
        b = Path.TrimEndingDirectorySeparator(Path.GetFullPath(b));
        return Within(a,b) || Within(b,a);
    }

    private static bool Within(string path, string parent) =>
        path.Equals(parent, StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith(Path.EndsInDirectorySeparator(parent) ? parent : parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    internal static void LexicalCheck(string folder, IEnumerable<string> forbidden)
    {
        if (forbidden.Where(p => !string.IsNullOrWhiteSpace(p)).Any(p => Overlaps(p,folder))) throw UnsafePath();
    }

    // Caller holds these handles during publication so a rename cannot move
    // a previously validated local directory into a watched tree.
    internal sealed class DirectoryPin : IDisposable
    {
        private readonly List<SafeFileHandle> handles = [];
        internal List<FileKey> Keys { get; } = [];

        internal DirectoryPin(string path)
        {
            try
            {
                for (var node = new DirectoryInfo(path); node != null; node = node.Parent)
                {
                    var attributes = File.GetAttributes(node.FullName);
                    if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
                        throw UnsafePath();
                    if (!OperatingSystem.IsWindows()) continue;
                    var handle = OpenDirectory(node.FullName, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                    if (handle.IsInvalid) { handle.Dispose(); ThrowWin32(); }
                    handles.Add(handle);
                    if (!GetFileInformationByHandle(handle, out var info)) ThrowWin32();
                    if ((info.Attributes & (uint)FileAttributes.ReparsePoint) != 0) throw UnsafePath();
                    var index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
                    if (index == 0) throw UnsafePath();
                    Keys.Add(new(info.Volume, index));
                }
            }
            catch { Dispose(); throw; }
        }

        internal void Exclude(string other)
        {
            using var compared = new DirectoryPin(other);
            ExcludeKeys(compared.KeyStrings);
        }

        internal string[] KeyStrings => Keys.Select(k=>$"{k.Volume:x8}:{k.Index:x16}").ToArray();
        internal void ExcludeKeys(string[] other)
        {
            var keys = KeyStrings;
            if (keys.Length>0 && other.Length>0 && (keys.Contains(other[0]) || other.Contains(keys[0]))) throw UnsafePath();
        }

        public void Dispose()
        {
            foreach (var handle in handles) handle.Dispose();
            handles.Clear();
        }
    }

    internal readonly record struct FileKey(uint Volume, ulong Index);
    [StructLayout(LayoutKind.Sequential)]
    private struct HandleInfo
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle OpenDirectory(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
    private static void ThrowWin32()
    {
        var code = Marshal.GetLastWin32Error();
        if (code == 5) throw new UnauthorizedAccessException();
        throw new IOException("The directory could not be verified.", new Win32Exception(code));
    }

    internal static void OrdinaryFile(string path)
    {
        try
        {
            if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw UnsafePath();
        }
        catch (FileNotFoundException) { }
    }

    internal static DirectoryPin Verify(string folder, IEnumerable<string> forbidden)
    {
        var roots = forbidden.Where(p => !string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        LexicalCheck(folder, roots);
        var pin = new DirectoryPin(folder);
        try
        {
            foreach (var root in roots) pin.Exclude(root);
            return pin;
        }
        catch { pin.Dispose(); throw; }
    }
}
