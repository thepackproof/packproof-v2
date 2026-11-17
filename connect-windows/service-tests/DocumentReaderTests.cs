using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using NPOI.HSSF.UserModel;
using PackProof.Connect;
using Xunit;
using ZXing;

public sealed class DocumentReaderTests
{
    private static string Fixture(string file)
    {
        var dir=new DirectoryInfo(AppContext.BaseDirectory);
        while(dir!=null)
        {
            var path=Path.Combine(dir.FullName,"examples","multisource-journey","fixtures",file);
            if(File.Exists(path))return path;
            dir=dir.Parent;
        }
        throw new FileNotFoundException("Controlled document fixture unavailable.",file);
    }
    [Fact]
    public void Binary_xls_preserves_string_ids_and_labels_cached_formula()
    {
        using var workbook=new HSSFWorkbook();
        var sheet=workbook.CreateSheet("Orders");
        var header=sheet.CreateRow(0);header.CreateCell(0).SetCellValue("Order");header.CreateCell(1).SetCellValue("Computed");
        var row=sheet.CreateRow(1);row.CreateCell(0).SetCellValue("000045");row.CreateCell(1).SetCellFormula("1+1");
        using var output=new MemoryStream();workbook.Write(output,true);
        var result=SourceReaders.Read("sample.xls",output.ToArray(),new(Sheet:"Orders"));
        var parsed=Assert.Single(result.Rows);
        Assert.Equal("000045",parsed.Fields["Order"].GetString());Assert.True(parsed.Fields["Computed"].TryGetProperty("cached",out _));
    }
    [Fact]
    public void Text_pdf_reports_actual_page_and_rectangle()
    {
        var bytes=File.ReadAllBytes(Fixture("packing_text.pdf"));
        var result=SourceReaders.ReadDerived("packing_text.pdf",bytes);
        Assert.Contains(result.Rows,row=>row.Fields["text"].GetString()=="SO10482" &&
            row.Fields["region"].GetProperty("unit").GetString()=="PDF points" && row.Location.StartsWith("page 1/"));
    }
    [Theory]
    [InlineData("packing_photo.jpg")]
    [InlineData("packing_scan.pdf")]
    public void English_ocr_produces_derived_words_confidence_and_region(string name)
    {
        Assert.True(OperatingSystem.IsWindows(),"Native OCR qualification requires Windows.");
        var result=SourceReaders.ReadDerived(name,File.ReadAllBytes(Fixture(name)));
        Assert.True(result.Rows.Any(row=>row.Fields["method"].GetString()=="ocr/eng" &&
            row.Fields["text"].GetString()!.Contains("DEMO",StringComparison.OrdinalIgnoreCase) &&
            row.Fields["confidence"].GetDouble() is >=0 and <=100 && row.Fields["region"].GetProperty("width").GetInt32()>0),
            string.Join(" ",result.Issues));
    }
    [Theory]
    [InlineData("png")]
    [InlineData("tiff")]
    public void Reads_barcode_pixels_without_inferring_order_identity(string format)
    {
        Assert.True(OperatingSystem.IsWindows(),"Image qualification requires Windows.");
        var writer=new BarcodeWriterPixelData{Format=BarcodeFormat.QR_CODE,Options=new(){Width=160,Height=160,Margin=4}};
        var data=writer.Write("PKG-0092");
        using var bitmap=new Bitmap(data.Width,data.Height,PixelFormat.Format32bppArgb);
        var area=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
        try{Marshal.Copy(data.Pixels,0,area.Scan0,data.Pixels.Length);}finally{bitmap.UnlockBits(area);}
        using var output=new MemoryStream();bitmap.Save(output,format=="png"?ImageFormat.Png:ImageFormat.Tiff);
        var result=SourceReaders.ReadDerived("barcode."+format,output.ToArray());
        Assert.Contains(result.Rows,row=>row.Fields["method"].GetString()=="barcode/QR_CODE" && row.Fields["text"].GetString()=="PKG-0092");
        Assert.Equal(0,SourceReaders.Normalize(result,"evidence").GetArrayLength());
    }
    [Theory]
    [InlineData("packing_photo.heic")]
    [InlineData("packing_photo.webp")]
    public void Qualified_windows_codec_reads_still_or_reports_missing_extension(string name)
    {
        var bytes=File.ReadAllBytes(Fixture(name));
        Assert.Equal("recognized",SourceReaders.Read(name,bytes).State);
        try
        {
            var decoded=WindowsSourceCodec.DecodeStill(bytes);
            Assert.Equal(240,decoded.Width);Assert.Equal(80,decoded.Height);Assert.Equal(240*80*4,decoded.Bgra.Length);
        }
        catch(InvalidDataException e) when(e.Message.Contains("installed Windows codec",StringComparison.Ordinal))
        {
            var pending=SourceReaders.ReadDerived(name,bytes);
            Assert.Equal("recognized",pending.State);
            Assert.Contains(pending.Issues,issue=>issue.Contains("installed Windows codec",StringComparison.Ordinal));
        }
    }
}