using System.Runtime.InteropServices;

namespace PackProof.Connect;

// Only called inside the memory/time-limited media worker. WIC reads the provided
// memory stream; file paths and codec names from a source are never executed.
internal static class WindowsSourceCodec
{
    [ComImport,Guid("EC5EC8A9-C395-4314-9C77-54D7A935FF70"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFactory
    {
        void CreateDecoderFromFilename();
        void CreateDecoderFromStream(IntPtr stream,IntPtr vendor,uint metadataCache,out IDecoder decoder);
    }
    [ComImport,Guid("9EDDE9E7-8DEE-47EA-99DF-E6FAF2ED44BF"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDecoder
    {
        void QueryCapability(); void Initialize(); void GetContainerFormat(); void GetDecoderInfo(); void CopyPalette();
        void GetMetadataQueryReader(); void GetPreview(); void GetColorContexts(); void GetThumbnail();
        void GetFrameCount(out uint count);
        void GetFrame(uint index,out IntPtr frame);
    }
    [ComImport,Guid("00000120-A8F2-4877-BA0A-FD2B6645FB94"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISource
    {
        void GetSize(out uint width,out uint height);
        void GetPixelFormat(); void GetResolution(); void CopyPalette();
        void CopyPixels(IntPtr rectangle,uint stride,uint bufferBytes,[Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)]byte[] pixels);
    }
    [DllImport("shlwapi.dll",ExactSpelling=true)]private static extern IntPtr SHCreateMemStream(byte[] bytes,uint length);
    [DllImport("windowscodecs.dll",ExactSpelling=true)]private static extern int WICConvertBitmapSource(in Guid format,IntPtr frame,out ISource source);

    public static (int Width,int Height,byte[] Bgra) DecodeStill(byte[] bytes)
    {
        if(!OperatingSystem.IsWindows())throw new InvalidDataException("This image needs a qualified Windows codec.");
        var clsid=new Guid("cacaf262-9370-4615-a13b-9f5539da4c0a");
        var pixelFormat=new Guid("6fddc324-4e03-4bfe-b185-3d77768dc90f");
        IFactory? factory=null;IDecoder? decoder=null;ISource? bitmap=null;IntPtr frame=IntPtr.Zero;
        IntPtr stream=SHCreateMemStream(bytes,checked((uint)bytes.Length));
        if(stream==IntPtr.Zero)throw new InvalidDataException("The Windows image codec could not allocate a stream.");
        try
        {
            factory=(IFactory)Activator.CreateInstance(Type.GetTypeFromCLSID(clsid,true)!)!;
            factory.CreateDecoderFromStream(stream,IntPtr.Zero,0,out decoder);
            decoder.GetFrameCount(out uint count);
            if(count!=1)throw new InvalidDataException("This source profile supports single-frame HEIC and WebP images.");
            decoder.GetFrame(0,out frame);
            Marshal.ThrowExceptionForHR(WICConvertBitmapSource(in pixelFormat,frame,out bitmap));
            bitmap.GetSize(out uint width,out uint height);
            if(width is 0 or >8192||height is 0 or >8192||(long)width*height>12_000_000)
                throw new InvalidDataException("The image exceeds the pixel limit.");
            uint stride=checked(width*4),size=checked(stride*height);
            var pixels=new byte[size];bitmap.CopyPixels(IntPtr.Zero,stride,size,pixels);
            return((int)width,(int)height,pixels);
        }
        catch(COMException){throw new InvalidDataException("An installed Windows codec could not decode this image. Keep its original or use JPEG, PNG or TIFF.");}
        finally
        {
            if(bitmap!=null)Marshal.ReleaseComObject(bitmap);
            if(frame!=IntPtr.Zero)Marshal.Release(frame);
            if(decoder!=null)Marshal.ReleaseComObject(decoder);
            if(factory!=null)Marshal.ReleaseComObject(factory);
            Marshal.Release(stream);
        }
    }
}
