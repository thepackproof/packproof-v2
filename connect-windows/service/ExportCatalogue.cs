using System.Text.Json;

namespace PackProof.Connect;

internal sealed record ExportRowCondition(string Column, string[] AcceptedValues);
internal sealed record ExportOrderColumns(string Order, string Line, string Quantity, string Unit,
    string Sku, string Company, string SourceRevision, string ReportAsOf, ExportRowCondition? RowCondition,
    string? DisplayOrderReference);
internal sealed record ExportProfile(string Id, string Label, string Role, string[] RequiredHeaders,
    string Guidance, ExportOrderColumns? OrderColumns);

internal static class ExportCatalogue
{
    private sealed record Catalogue(int Version, ExportProfile[] Profiles);
    private static readonly ExportProfile[] Profiles = Load();

    private static ExportProfile[] Load()
    {
        using var stream = typeof(ExportCatalogue).Assembly.GetManifestResourceStream("PackProof.Connect.ExportCatalogue.json")
            ?? throw new InvalidDataException("The export catalogue is missing.");
        var catalogue = JsonSerializer.Deserialize<Catalogue>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (catalogue?.Version != 1 || catalogue.Profiles.Length == 0)
            throw new InvalidDataException("The export catalogue version is unsupported.");
        return catalogue.Profiles;
    }

    internal static ExportProfile? Match(IReadOnlyList<string> headers) => Match(headers, out _);

    internal static ExportProfile? Match(IReadOnlyList<string> headers, out bool ambiguous)
    {
        var names = headers.Select(h => h.Trim()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var matches = Profiles.Where(p => p.RequiredHeaders.All(names.Contains)).Take(2).ToArray();
        ambiguous = matches.Length > 1 || (matches.Length > 0 && names.Count != headers.Count);
        return matches.Length == 1 && !ambiguous ? matches[0] : null;
    }
}
