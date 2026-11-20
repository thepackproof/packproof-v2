using System.Text.RegularExpressions;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    private static readonly Dictionary<string,string[]> OperationalHeadings=new(StringComparer.Ordinal)
    {
        ["orderId"]=["SalesOrderID","SalesOrderNumber","OrderNumber","OrderID"],
        ["warehouseId"]=["WarehouseOrder","WarehouseOrderID","WarehouseOrderNumber","WorkOrderNumber","PickTicket","PickTicketNumber"],
        ["shipmentId"]=["ShipmentID","ShipmentNumber","OutboundShipmentNumber"],
        ["packageId"]=["PackageID","PackageNumber","SSCC","CartonID","CartonNumber","LicensePlateNumber","LPN"],
        ["trackingId"]=["TrackingNumber","TrackingID","CarrierTrackingNumber"],
        ["trackingCarrier"]=["CarrierCode","Carrier","SCAC"],["trackingAccount"]=["CarrierAccount","CarrierAccountNumber","CarrierAccountID"],
        ["trackingPeriod"]=["TrackingPeriod","ShipmentPeriod","ShipDate","ShipmentDate","OriginalShipDate"],
        ["handoffId"]=["HandoffID","DispatchEventID","HandoffEventID"],["deliveryId"]=["DeliveryEventID","PODID","ProofOfDeliveryID","DeliveryID"],
        ["returnId"]=["ReturnID","ReturnNumber","RMANumber","RMAID"],["eventId"]=["EventID","SourceEventID","TransactionEventID"],
        ["lineId"]=["SalesOrderLineID","SalesOrderLineNumber","OrderLineID","OrderLineNumber","LineID","LineNumber"],
        ["sku"]=["SKU","ItemSKU","ItemCode"],["unit"]=["UOM","Unit","UnitOfMeasure","QuantityUnit"],
        ["version"]=["RecordVersion","SourceRevision","RowVersion","RecordRevision","Version","Revision"],
        ["asOf"]=["SourceModifiedAt","LastModifiedAt","UpdatedAt","LastUpdated","ModifiedAt","ReportAsOf","SnapshotAt"],
        ["packedAt"]=["PackedAt","PackingCompletedAt"],["pickedAt"]=["PickedAt","PickCompletedAt"],
        ["labelAt"]=["LabelCreatedAt","LabelPrintedAt"],["handoffAt"]=["HandedOffAt","DepartedAt","DispatchTime","HandoffAt"],
        ["deliveryAt"]=["DeliveredAt","DeliveryConfirmedAt","PODSignedAt"],["returnAt"]=["ReturnReceivedAt","InspectionCompletedAt"],
        ["eventAt"]=["OccurredAt","EventTime","EventTimestamp"],
        ["pickedQuantity"]=["PickedQuantity","PickedQty","QuantityPicked","QtyPicked"],
        ["packedQuantity"]=["PackedQuantity","PackedQty","QuantityPacked","QtyPacked","PackedUnits"],
        ["loadedQuantity"]=["LoadedQuantity","LoadedQty","QtyLoaded","QuantityLoaded"],
        ["acknowledgedQuantity"]=["AcknowledgedQuantity","AcknowledgedQty","QtyAcknowledged","QuantityAcknowledged","ReceivedQuantity","QtyReceived"],
        ["shippedQuantity"]=["ShippedQuantity","ShippedQty","QuantityShipped","QtyShipped"],
        ["returnedQuantity"]=["ReceivedReturnQuantity","ReturnedQuantity","ReturnReceivedQty","QtyReturned"],
        ["state"]=["EventStatus","ShipmentStatus","DeliveryStatus","HandoffStatus","ReturnStatus","LabelStatus","Status"],
        ["loadId"]=["LoadID","LoadNumber"],["weight"]=["Weight","MeasuredWeight","PackageWeight"],["weightUnit"]=["WeightUnit","WeightUOM"]
    };
    private static readonly Dictionary<string,string> ReferenceRole=new(StringComparer.Ordinal){
        ["order"]="order",["warehouse"]="picking",["package"]="packing",["shipment"]="shipping",["tracking"]="shipping"};
    private static readonly Dictionary<string,(string subject,string quantity,string time)> OperationalRoles=new(StringComparer.Ordinal){
        ["picking"]=("warehouse","pickedQuantity","pickedAt"),["packing"]=("package","packedQuantity","packedAt"),
        ["shipping"]=("shipment","","labelAt"),["handoff"]=("handoff","shippedQuantity","handoffAt"),
        ["delivery"]=("delivery","","deliveryAt"),["returns"]=("return","returnedQuantity","returnAt")};

    private static string WorkflowKey(string header) => Regex.Replace(header,@"[\s_-]","").ToLowerInvariant();

    internal static Dictionary<string,string>? WorkflowHeaders(IReadOnlyList<string> headers)
    {
        var columns=new Dictionary<string,string>(StringComparer.Ordinal);
        var byName = headers.ToLookup(WorkflowKey);
        foreach(var (semantic,aliases) in OperationalHeadings)
        {
            var matches=aliases.SelectMany(alias=>byName[WorkflowKey(alias)]).ToArray();
            if(matches.Length>1)return null;
            if(matches.Length==1)columns.Add(semantic,matches[0]);
        }
        return columns;
    }

    private static bool FitsWorkflow(string role, Dictionary<string,string> columns)
    {
        if (!OperationalRoles.TryGetValue(role,out var rule)) return false;
        if(!columns.ContainsKey("version")&&!columns.ContainsKey("asOf")&&
            !((columns.ContainsKey("eventId")||role is "handoff" or "delivery" && columns.ContainsKey(rule.subject+"Id"))&&(columns.ContainsKey(rule.time)||columns.ContainsKey("eventAt"))))return false;
        bool fullTracking=TrackingColumns(columns);
        bool hasSubject=columns.ContainsKey(rule.subject+"Id");
        if(role=="shipping")hasSubject=hasSubject || fullTracking;
        if(role is "handoff" or "delivery")hasSubject=hasSubject || columns.ContainsKey("eventId");
        if(!hasSubject)return false;
        if(WorkflowAmounts(role,rule.quantity).Any(columns.ContainsKey)&&(!columns.ContainsKey("lineId")||!columns.ContainsKey("unit")))return false;
        return true;
    }

    // Discovery can identify a likely stage from a report layout without binding any producer IDs.
    internal static IEnumerable<string> DiscoveryWorkflowRoles(Dictionary<string,string> columns)
    {
        foreach (var (role, rule) in OperationalRoles)
        {
            if (!FitsWorkflow(role,columns)) continue;
            bool hasReference = ReferenceRole.Any(p=>p.Value!=role && columns.ContainsKey(p.Key+"Id") &&
                (p.Key!="tracking" || TrackingColumns(columns)));
            bool roleEvidence = columns.ContainsKey(rule.time) ||
                WorkflowAmounts(role,rule.quantity).Any(columns.ContainsKey) ||
                role is "handoff" or "delivery" or "returns" && columns.ContainsKey(rule.subject+"Id");
            if (hasReference && roleEvidence) yield return role;
        }
    }

    private static IEnumerable<string> WorkflowAmounts(string role,string primary)
    {
        if(primary!="")yield return primary;
        if(role is "shipping" or "handoff")yield return "loadedQuantity";
        if(role=="delivery")yield return "acknowledgedQuantity";
    }
    private static bool TrackingColumns(Dictionary<string,string> columns) =>
        new[]{"trackingId","trackingCarrier","trackingAccount","trackingPeriod"}.All(columns.ContainsKey);

}
