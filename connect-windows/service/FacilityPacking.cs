using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace PackProof.Connect;

public sealed record FacilityPacking(string SourceId,string OrderSourceId,string Schema,string CartonField,
    string? WeightField=null,string? UnitField=null,string? UnitValue=null,string? Unit=null);
public sealed record FacilityPackingReader(FacilityPacking Rule,string OrderNamespace,int OrderGeneration);
public sealed record FacilityRecordEdit(string SourceId,string RecordHash,string FromSpace,string FromId,string ToSpace,string ToId);

public static partial class SourceReaders
{
    internal static string PackingSchema(SourceReadResult sample) =>
        Convert.ToHexStringLower(SHA256.HashData(Json.Bytes(new {sample.Format,sample.ReaderVersion,sample.Headers})));

    internal static JsonElement[] NormalizeFacilityPacking(SourceReadResult sample,FacilityPackingReader reader)
    {
        var rule=reader.Rule;
        if (sample.State!="parsed" || PackingSchema(sample)!=rule.Schema || RecognizeExport(sample)!=null ||
            !sample.Headers.Contains(rule.CartonField,StringComparer.Ordinal)) return [];
        var columns=WorkflowHeaders(sample.Headers);
        if (columns is null || !columns.ContainsKey("orderId") ||
            columns.Any(p=>p.Key!="packageId" && p.Value==rule.CartonField) ||
            columns.TryGetValue("packageId",out var previous) && previous!=rule.CartonField) return [];
        columns["packageId"]=rule.CartonField;
        if (!FitsWorkflow("packing",columns)) return [];
        var map=new WorkflowColumnMap("packing",columns,new(){["order"]=reader.OrderNamespace});
        var normalized=NormalizeWorkflow(sample,rule.SourceId,map).EnumerateArray().ToArray();
        const string valueKey="qualifiedCartonWeight", unitKey="qualifiedCartonWeightUnit";
        if (sample.Headers.Contains(valueKey) || sample.Headers.Contains(unitKey)) return [];
        if (rule.WeightField is null || normalized.Length==0) return normalized;
        if (!sample.Headers.Contains(rule.WeightField) || rule.UnitField!=null && !sample.Headers.Contains(rule.UnitField) ||
            normalized.Length!=sample.Rows.Count) return [];
        for (int i=0;i<normalized.Length;i++)
        {
            var raw=sample.Rows[i];
            if (raw.Fields.ContainsKey(valueKey) || raw.Fields.ContainsKey(unitKey)) return [];
            var amount=Scalar(raw.Fields,rule.WeightField);
            if (rule.Unit is null || rule.UnitField is null || Scalar(raw.Fields,rule.UnitField)!=rule.UnitValue ||
                !decimal.TryParse(amount,NumberStyles.AllowDecimalPoint,CultureInfo.InvariantCulture,out var weight) || weight<0) continue;
            var record=normalized[i].EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value);
            var fields=record["fields"].EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value);
            var lineage=record["fieldLineage"].EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value);
            if(fields.Count>94 || !raw.Lineage.TryGetValue(rule.WeightField,out var weightAt) ||
                !raw.Lineage.TryGetValue(rule.UnitField,out var unitAt)) return [];
            fields[valueKey]=Val(amount); fields[unitKey]=Val(rule.Unit);
            lineage[valueKey]=Val(weightAt); lineage[unitKey]=Val(unitAt);
            record["fields"]=Val(fields); record["fieldLineage"]=Val(lineage);
            normalized[i]=Val(record);
        }
        return normalized;
    }
}
