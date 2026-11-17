using System.Globalization;
using System.IO.Compression;
using System.Text.Json;
using NPOI.SS.UserModel;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    private static void ReadWorkbook(byte[] bytes,string format,SourceReaderProfile profile,List<SourceReaderRow> rows,List<string> issues)
    {
        using var stream=new MemoryStream(bytes,false);
        try
        {
            Require(bytes.AsSpan().StartsWith(new byte[]{0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1}),"This file is not a binary Excel workbook.");
            Require(profile.Table==null,"Choose the worksheet in a binary Excel source.");
            using var book=new NPOI.HSSF.UserModel.HSSFWorkbook(stream);
            Require(book.NumberOfSheets is >0 and <=32,"The workbook exceeds the sheet limit.");
            if(profile.Sheet!=null)Require(book.GetSheet(profile.Sheet)!=null,"The source's approved worksheet is missing.");
            for(int i=0;i<book.NumberOfSheets;i++)
            {
                var sheet=book.GetSheetAt(i);
                if(profile.Sheet!=null && sheet.SheetName!=profile.Sheet)continue;
                Require(sheet.LastRowNum<=MaxRows+profile.SkipRows,"The workbook exceeds the bounded sheet row limit.");
                int headerNo=sheet.FirstRowNum+profile.SkipRows;var first=sheet.GetRow(headerNo);
                if(first==null)continue;
                Require(first.LastCellNum is >0 and <=MaxFields,"The worksheet exceeds the supported column limit.");
                var headers=Enumerable.Range(0,first.LastCellNum).Select(c=>first.GetCell(c)?.CellType==CellType.String ? first.GetCell(c).StringCellValue : "").ToArray();
                ValidateHeaders(headers);
                for(int j=headerNo+1;j<=sheet.LastRowNum;j++)
                {
                    var excelRow=sheet.GetRow(j);if(excelRow==null)continue;
                    Require(excelRow.LastCellNum<=headers.Length,"The worksheet has data outside the approved headings.");
                    var cells=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
                    foreach(var cell in excelRow.Cells)
                    {
                        bool formula=cell.CellType==CellType.Formula;var type=formula?cell.CachedFormulaResultType:cell.CellType;
                        object? value=type switch{
                            CellType.Blank=>null,CellType.Boolean=>cell.BooleanCellValue,CellType.String=>cell.StringCellValue,
                            CellType.Numeric when DateUtil.IsCellDateFormatted(cell)=>((DateTime?)cell.DateCellValue)?.ToString("yyyy-MM-ddTHH:mm:ss.fffffff",CultureInfo.InvariantCulture),
                            CellType.Numeric=>cell.NumericCellValue.ToString("R",CultureInfo.InvariantCulture),
                            CellType.Error=>new{error=cell.ErrorCellValue},_=>null};
                        if(value is string s)Require(s.Length<=MaxCell,"A workbook cell exceeds the size limit.");
                        // Formula results are explicitly marked as cached and cannot silently become identifiers.
                        cells[headers[cell.ColumnIndex]]=formula?Val(new{formula=cell.CellFormula,cached=value}):Val(value);
                    }
                    if(cells.Count==0)continue;
                    string loc=$"{sheet.SheetName}!row {j+1}";
                    Add(rows,Row(loc,cells,k=>$"{sheet.SheetName}!R{j+1}C{Array.IndexOf(headers,k)+1}"));
                }
            }
        }
        catch(Exception e) when(e is not (InvalidDataException or OutOfMemoryException or StackOverflowException or OperationCanceledException))
        {throw new InvalidDataException("The workbook could not be read. Check its format and protection settings.");}
    }
}
