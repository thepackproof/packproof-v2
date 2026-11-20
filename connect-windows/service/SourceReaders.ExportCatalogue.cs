using System.Text.Json;

namespace PackProof.Connect;

public sealed record CatalogueScope(string ProfileId, string CompanyColumn, string Company);

public static partial class SourceReaders
{
    internal static ExportProfile? RecognizeExport(SourceReadResult file) => RecognizeExport(file, out _);

    internal static ExportProfile? RecognizeExport(SourceReadResult file, out bool ambiguous)
    {
        ambiguous = false;
        return file.State == "parsed" && file.Format is ("csv" or "tsv" or "psv")
            ? ExportCatalogue.Match(file.Headers, out ambiguous) : null;
    }

    internal static string CompanyOrderNamespace(string sourceId, CatalogueScope scope)
    {
        // Order numbers can repeat across legal entities and across installations.
        var parts = JsonSerializer.SerializeToUtf8Bytes(new[] { sourceId, scope.ProfileId, scope.Company });
        return "company/" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(parts));
    }

    private static OrderColumnMap? ProposeExportMap(SourceReadResult file, ExportProfile profile)
    {
        var columns = profile.OrderColumns;
        if (columns == null || file.Rows.Count == 0) return null;
        var headers = file.Headers.ToDictionary(h => h.Trim(), StringComparer.OrdinalIgnoreCase);
        if (!headers.TryGetValue(columns.Company, out var companyHeader)) return null;
        if (columns.RowCondition is { } condition)
        {
            if (!headers.TryGetValue(condition.Column, out var status) ||
                file.Rows.Any(r => !condition.AcceptedValues.Contains(Scalar(r.Fields, status), StringComparer.Ordinal)))
                return null;
        }
        var revision = headers.GetValueOrDefault(columns.SourceRevision);
        var asOf = headers.GetValueOrDefault(columns.ReportAsOf);
        if ((revision == null) == (asOf == null)) return null;
        var company = file.Rows[0].Fields.GetValueOrDefault(companyHeader);
        if (company.ValueKind != JsonValueKind.String || !ValidCompany(company.GetString())) return null;
        string companyId = company.GetString()!;
        if (file.Rows.Any(r => !r.Fields.TryGetValue(companyHeader, out var v) ||
            v.ValueKind != JsonValueKind.String || v.GetString() != companyId)) return null;
        return new(headers[columns.Order], headers[columns.Line], revision ?? asOf!,
            headers[columns.Quantity], headers[columns.Unit], headers[columns.Sku],
            Catalogue: new(profile.Id, companyHeader, companyId),
            DisplayOrderReference: columns.DisplayOrderReference is { } display ? headers.GetValueOrDefault(display) : null);
    }

    private static bool ValidCompany(string? company) =>
        !string.IsNullOrWhiteSpace(company) && company.Length <= 100 &&
        company == company.Trim() && !company.Any(char.IsControl);
}
