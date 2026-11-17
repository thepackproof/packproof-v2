using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Tesseract;
using UglyToad.PdfPig;
using ZXing;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    public static bool IsMedia(string fileName) => Path.GetExtension(fileName).ToLowerInvariant() is
        ".pdf" or ".jpeg" or ".jpg" or ".tif" or ".tiff" or ".png";
    private static string InspectDocument(byte[] bytes,string format,List<SourceReaderRow> rows,List<string> issues)
    {
        var b=bytes.AsSpan();
        bool signature=format switch {
            "pdf"=>b.StartsWith("%PDF-"u8), "jpg" or "jpeg"=>b.StartsWith(new byte[]{0xff,0xd8,0xff}),
            "png"=>b.StartsWith(new byte[]{137,80,78,71,13,10,26,10}),
            "tif" or "tiff"=>b.StartsWith(new byte[]{73,73,42,0}) || b.StartsWith(new byte[]{77,77,0,42}),
            "webp"=>b.Length>=12 && b.StartsWith("RIFF"u8) && b[8..].StartsWith("WEBP"u8),
            "heic"=>b.Length>=12 && b[4..].StartsWith("ftyp"u8) && Encoding.ASCII.GetString(b[8..12]) is "heic" or "heix" or "mif1",
            "mp4" or "mov"=>b.Length>=12 && b[4..].StartsWith("ftyp"u8),_=>false};
        Require(signature,"The content does not match this file type.");
        issues.Add(IsMedia("."+format)?"The original is recognized. Text and barcode results are derived separately.":
            "The original container is recognized. A qualified decoder is required for interpretation.");
        return "recognized";
    }
    // This branch runs only inside the packaged service executable's bounded child process.
    public static async Task<int> RunMediaChild(string extension,CancellationToken ct)
    {
        if(!IsMedia("file."+extension))return 2;
        using var input=Console.OpenStandardInput();
        using var bytes=new MemoryStream();
        var buffer=new byte[8192];
        int count;
        while((count=await input.ReadAsync(buffer,ct))>0)
        {
            if(bytes.Length+count>MaxBytes)return 2;
            await bytes.WriteAsync(buffer.AsMemory(0,count),ct);
        }
        var parsed=ReadDerived("file."+extension,bytes.ToArray());
        await JsonSerializer.SerializeAsync(Console.OpenStandardOutput(),parsed,cancellationToken:ct);
        return 0;
    }
    public static async Task<SourceReadResult> ReadDerivedAsync(string fileName,byte[] bytes,CancellationToken ct)
    {
        var initial=Read(fileName,bytes);
        if(!IsMedia(fileName)||initial.State!="recognized")return initial;
        // Never resolve an executable from a source folder, the current working directory or PATH.
        var exe=Path.Combine(AppContext.BaseDirectory,"PackProof.Connect.Service.exe");
        if(!File.Exists(exe))return initial with {Issues=["The media reader is unavailable. The original remains available."]};
        var start=new ProcessStartInfo(exe){CreateNoWindow=true,UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,
            WorkingDirectory=AppContext.BaseDirectory};
        start.ArgumentList.Add("--read-source-media");start.ArgumentList.Add(initial.Format);
        using var process=new Process{StartInfo=start};
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        try
        {
            process.Start();
            using var kill=timeout.Token.Register(()=>{try{if(!process.HasExited)process.Kill(true);}catch(InvalidOperationException){}});
            // Only the bounded machine-readable result is consumed. Native diagnostics stay out of general logs.
            var read=ReadMediaOutput(process.StandardOutput.BaseStream,timeout.Token);
            var discard=process.StandardError.BaseStream.CopyToAsync(Stream.Null,timeout.Token);
            await process.StandardInput.BaseStream.WriteAsync(bytes,timeout.Token);
            process.StandardInput.Close();
            while(!process.HasExited)
            {
                process.Refresh();
                if(process.WorkingSet64>384L*1024*1024 || read.IsFaulted){process.Kill(true);break;}
                await Task.Delay(100,timeout.Token);
            }
            await process.WaitForExitAsync(timeout.Token);
            await discard;
            var output=await read;
            if(process.ExitCode==0 && output.ContentSha256==initial.ContentSha256 && output.ReaderVersion==Version)return output;
        }
        catch(Exception e) when(e is IOException or OperationCanceledException or InvalidOperationException or System.ComponentModel.Win32Exception or JsonException or InvalidDataException)
        {
            try{if(!process.HasExited)process.Kill(true);}catch(InvalidOperationException){}
            ct.ThrowIfCancellationRequested();
        }
        return initial with {Issues=["The bounded media check could not finish. The original remains available for review."]};
    }
    private static async Task<SourceReadResult> ReadMediaOutput(Stream stream,CancellationToken ct)
    {
        using var data=new MemoryStream();byte[] buf=new byte[8192];int n;
        while((n=await stream.ReadAsync(buf,ct))>0){Require(data.Length+n<=4*1024*1024,"The derived report exceeds the output limit.");data.Write(buf,0,n);}
        return JsonSerializer.Deserialize<SourceReadResult>(data.ToArray())??throw new InvalidDataException("The media reader returned an empty report.");
    }
    internal static SourceReadResult ReadDerived(string fileName,byte[] bytes)
    {
        var initial=Read(fileName,bytes);
        if(!IsMedia(fileName)||initial.State!="recognized")return initial;
        var rows=new List<SourceReaderRow>();var issues=new List<string>();
        try
        {
            if(initial.Format=="pdf")
            {
                using var pdf=PdfDocument.Open(bytes);
                Require(pdf.NumberOfPages is >0 and <=32,"The document exceeds the page limit.");
                foreach(var page in pdf.GetPages())
                {
                    string path=$"page {page.Number}";bool text=false;
                    foreach(var word in page.GetWords())
                    {
                        text=true;var b=word.BoundingBox;
                        MediaRow(rows,path,"pdf_text",word.Text,null,new {x=b.Left,y=b.Bottom,width=b.Width,height=b.Height,unit="PDF points"});
                    }
                    if(!text)
                    {
                        int imageNo=0;
                        foreach(var img in page.GetImages())
                        {
                            Require(++imageNo<=8,"The page exceeds the image limit.");
                            Dimensions(img.WidthInSamples,img.HeightInSamples);
                            byte[]? decoded=null;
                            if(img.RawBytes.Span.StartsWith(new byte[]{0xff,0xd8,0xff}))decoded=img.RawBytes.ToArray();
                            else if(img.TryGetPng(out var png))decoded=png;
                            if(decoded!=null)ReadImage(decoded,$"{path}/image {imageNo}",rows,issues);
                            else issues.Add($"The embedded image on {path} uses an unsupported encoding.");
                        }
                        if(imageNo==0)issues.Add($"{path} has no supported text or image content.");
                    }
                }
            }
            else ReadImage(bytes,"image",rows,issues);
        }
        catch(Exception e) when(e is not (OutOfMemoryException or StackOverflowException or OperationCanceledException))
        {rows.Clear();issues.Add(e is InvalidDataException?e.Message:"The document could not be decoded. The original remains available.");}
        return initial with {State=rows.Count>0?"parsed":"recognized",Rows=rows,Headers=rows.SelectMany(r=>r.Fields.Keys).Distinct().ToArray(),Issues=issues.Distinct().ToArray()};
    }
    private static void Dimensions(int w,int h) => Require(w>0&&h>0&&w<=8192&&h<=8192&&(long)w*h<=12_000_000,"The image exceeds the supported pixel limit.");
    private static void MediaRow(List<SourceReaderRow> rows,string path,string method,string value,float? confidence,object region)
    {
        Require(value.Length<=MaxCell,"A derived value exceeds the field limit.");
        string location=$"{path}/result {rows.Count+1}";
        Add(rows,Row(location,new(){["method"]=Val(method),["text"]=Val(value),["confidence"]=Val(confidence),["region"]=Val(region)},k=>location+"/"+k));
    }
    private static void ReadImage(byte[] bytes,string path,List<SourceReaderRow> rows,List<string> issues)
    {
        if(!OperatingSystem.IsWindows())throw new InvalidDataException("The Windows document decoder is unavailable.");
        using var src=new MemoryStream(bytes,false);
        using var image=Image.FromStream(src,false,false);
        Dimensions(image.Width,image.Height);
        var dimension=new FrameDimension(image.FrameDimensionsList[0]);int frames=image.GetFrameCount(dimension);
        Require(frames is >0 and <=16,"The document exceeds the image-frame limit.");
        for(int i=0;i<frames;i++)
        {
            image.SelectActiveFrame(dimension,i);
            Dimensions(image.Width,image.Height);
            using var bmp=new Bitmap(image.Width,image.Height,PixelFormat.Format32bppArgb);
            using(var g=Graphics.FromImage(bmp)){g.Clear(Color.White);g.DrawImage(image,0,0,bmp.Width,bmp.Height);}
            string frame=$"{path}/frame {i+1}";
            var rect=new Rectangle(0,0,bmp.Width,bmp.Height);var bits=bmp.LockBits(rect,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
            try
            {
                byte[] pixels=new byte[checked(bmp.Width*bmp.Height*4)];
                for(int y=0;y<bmp.Height;y++)Marshal.Copy(bits.Scan0+y*bits.Stride,pixels,y*bmp.Width*4,bmp.Width*4);
                var luminance=new RGBLuminanceSource(pixels,bmp.Width,bmp.Height,RGBLuminanceSource.BitmapFormat.BGRA32);
                var barcode=new BarcodeReaderGeneric().Decode(luminance);
                if(barcode!=null)MediaRow(rows,frame,"barcode/"+barcode.BarcodeFormat,barcode.Text,null,new{points=barcode.ResultPoints?.Select(p=>new{p.X,p.Y}),unit="pixels"});
            }
            finally{bmp.UnlockBits(bits);}
            string language=Path.Combine(AppContext.BaseDirectory,"tessdata");
            if(!File.Exists(Path.Combine(language,"eng.traineddata"))){issues.Add("English OCR data is unavailable. The original remains available.");continue;}
            try
            {
                using var buffer=new MemoryStream();bmp.Save(buffer,ImageFormat.Png);
                using var pix=Pix.LoadFromMemory(buffer.ToArray());
                using var engine=new TesseractEngine(language,"eng",EngineMode.LstmOnly);
                using var page=engine.Process(pix);using var iter=page.GetIterator();iter.Begin();
                do
                {
                    string? value=iter.GetText(PageIteratorLevel.Word);
                    if(!string.IsNullOrWhiteSpace(value)&&iter.TryGetBoundingBox(PageIteratorLevel.Word,out var box))
                        MediaRow(rows,frame,"ocr/eng",value,iter.GetConfidence(PageIteratorLevel.Word),new {x=box.X1,y=box.Y1,width=box.X2-box.X1,height=box.Y2-box.Y1,unit="pixels"});
                }while(iter.Next(PageIteratorLevel.Word));
            }
            catch(Exception e) when(e is not (OutOfMemoryException or StackOverflowException or InvalidDataException))
            {issues.Add("The OCR engine could not read this image. The original remains available.");}
        }
    }
}
