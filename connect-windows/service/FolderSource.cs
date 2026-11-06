using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using CsvHelper;
using CsvHelper.Configuration;
using Microsoft.Win32.SafeHandles;
namespace PackProof.Connect;

public static class FolderSource
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
    private static string Final(SafeFileHandle h) { var chars = new char[32768]; var n = GetFinalPath(h, chars, (uint)chars.Length, 0); if (n == 0 || n >= chars.Length) throw Error(); return new string(chars, 0, (int)n).Replace(@"\\?\", ""); }
    private static ConnectException Error() => new("SOURCE_ACCESS_DENIED", "The collection service cannot safely read this source. Ask IT to grant this service read/list access to a dedicated local NTFS export folder.");
    public static string Validate(string input)
    {
        if (!OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(input) || input.Length > 260 || input.StartsWith(@"\\") || input.IndexOf(':', 2) >= 0 || !Path.IsPathFullyQualified(input)) throw Error();
        var path = Path.GetFullPath(input).TrimEnd(Path.DirectorySeparatorChar); var drive = new DriveInfo(Path.GetPathRoot(path)!);
        if (drive.DriveType != DriveType.Fixed || !drive.DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase) || path == drive.RootDirectory.FullName.TrimEnd('\\')) throw Error();
        var blocked = new[] { Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PackProof", "Connect") };
        if (blocked.Where(x => x.Length > 0).Any(x => path.Equals(x, StringComparison.OrdinalIgnoreCase) || path.StartsWith(x + "\\", StringComparison.OrdinalIgnoreCase))) throw Error();
        for (var node = new DirectoryInfo(path); node is not null; node = node.Parent) if ((node.Attributes & FileAttributes.ReparsePoint) != 0) throw Error();
        using var h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero); if (h.IsInvalid || !Final(h).Equals(path, StringComparison.OrdinalIgnoreCase)) throw Error();
        _ = Directory.EnumerateFiles(path).Take(1).ToArray(); return path;
    }
    public static IReadOnlyList<object> Inventory(string folder)
    {
        folder = Validate(folder); var result = new List<object>(); var examined = 0; foreach (var file in Directory.EnumerateFileSystemEntries(folder, "*", SearchOption.TopDirectoryOnly))
        {
            if (++examined > 10000) throw new ConnectException("SOURCE_CAPACITY_REACHED", "This dedicated export folder contains too many entries. Ask the source owner to apply the agreed export retention policy.");
            if ((File.GetAttributes(file) & FileAttributes.Directory) != 0) continue;
            if (!Path.GetExtension(file).Equals(".csv", StringComparison.OrdinalIgnoreCase)) continue;
            if (result.Count >= 10000) throw new ConnectException("SOURCE_CAPACITY_REACHED", "This source folder contains too many final CSV files. Ask the source owner to apply the agreed export retention policy.");
            var f = new FileInfo(file); result.Add(new { name = f.Name, byteSize = f.Length });
        }
        return result;
    }
    public static byte[] Snapshot(string folder, string fileName)
    {
        folder = Validate(folder); if (fileName != Path.GetFileName(fileName) || !fileName.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw Error();
        // Deny directory rename while resolving and opening the final immutable file.
        using var directory = CreateFile(folder, 0x80000000, 3, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero); if (directory.IsInvalid || !Final(directory).Equals(folder, StringComparison.OrdinalIgnoreCase)) throw Error();
        var path = Path.Combine(folder, fileName); using var handle = CreateFile(path, 0x80000000, 1, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero);
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) || (info.Attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Offline)) != 0 || info.Links != 1 || !Final(handle).Equals(path, StringComparison.OrdinalIgnoreCase)) throw Error();
        using var stream = new FileStream(handle, FileAccess.Read); if (stream.Length == 0 || stream.Length > MaxCsvBytes) throw new ConnectException("CSV_SIZE_UNSUPPORTED", "Use a nonempty UTF-8 CSV export no larger than 2 MiB. The original will not be split.");
        var bytes = new byte[(int)stream.Length]; stream.ReadExactly(bytes); if (stream.ReadByte() != -1) throw new ConnectException("SOURCE_CHANGED", "The export changed during collection. The producer must publish complete immutable files.");
        _ = new UTF8Encoding(false, true).GetString(bytes); return bytes;
    }
    private static string Display(string value, int max) => value.Length > max ? value[..max] + "…" : value;
    public static object Preview(byte[] bytes)
    {
        var text = new UTF8Encoding(false, true).GetString(bytes); var config = new CsvConfiguration(CultureInfo.InvariantCulture) { HasHeaderRecord = true, DetectDelimiter = true, DetectDelimiterValues = [",", ";", "\t"], MaxFieldSize = 10000, ExceptionMessagesContainRawData = false };
        using var reader = new CsvReader(new StringReader(text.TrimStart('\uFEFF')), config);
        try
        {
            if (!reader.Read()) throw new ConnectException("INVALID_CSV", "Include a header row and at least one shipment row."); reader.ReadHeader(); var headers = reader.HeaderRecord ?? [];
            if (headers.Length == 0 || headers.Length > 50 || headers.Any(x => string.IsNullOrWhiteSpace(x) || x.Length > 200) || headers.Distinct(StringComparer.Ordinal).Count() != headers.Length) throw new ConnectException("INVALID_CSV", "Use at most 50 uniquely named columns.");
            var samples = new List<Dictionary<string, string>>(); var count = 0; while (reader.Read())
            {
                count++; if (count > 1000) throw new ConnectException("CSV_ROW_LIMIT", "Use at most 1,000 shipment rows per export."); if (reader.Parser.Count != headers.Length) throw new ConnectException("INVALID_CSV", "A source row has a different number of columns from its header.");
                if (samples.Count < 10) samples.Add(headers.Select((h, i) => (h, i)).ToDictionary(x => x.h, x => Display(reader.GetField(x.i) ?? "", 40)));
            }
            if (count == 0) throw new ConnectException("INVALID_CSV", "Include at least one shipment row.");
            while (samples.Count > 0 && Json.Bytes(new { headers, samples }).Length > 65536) samples.RemoveAt(samples.Count - 1);
            return new { headers, samples, displaySamplesTruncated = count > samples.Count, rowCount = count, fileSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), byteSize = bytes.Length };
        }
        catch (CsvHelperException) { throw new ConnectException("INVALID_CSV", "The source is not a supported UTF-8 CSV export. Ask the source owner to correct its structure."); }
    }
}
