param(
    [string]$ShortcutPath = (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LifeOS Pulse.lnk"),
    [string]$AppUserModelId = "LifeOS.Pulse"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace LifeOS.Windows {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  internal class ShellLink { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  internal interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath, IntPtr findData, uint flags);
    void GetIDList(out IntPtr idList);
    void SetIDList(IntPtr idList);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int maxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int maxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out ushort hotkey);
    void SetHotkey(ushort hotkey);
    void GetShowCmd(out int showCmd);
    void SetShowCmd(int showCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int iconPathLength, out int iconIndex);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  internal interface IPropertyStore {
    uint GetCount();
    void GetAt(uint propertyIndex, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
  internal interface IPersistFile {
    void GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  internal struct PropertyKey {
    internal Guid FormatId;
    internal uint PropertyId;
    internal PropertyKey(string formatId, uint propertyId) { FormatId = new Guid(formatId); PropertyId = propertyId; }
  }

  [StructLayout(LayoutKind.Explicit)]
  internal struct PropVariant : IDisposable {
    [FieldOffset(0)] private ushort valueType;
    [FieldOffset(8)] private IntPtr pointerValue;
    internal static PropVariant FromString(string value) {
      PropVariant variant = new PropVariant();
      variant.valueType = 31;
      variant.pointerValue = Marshal.StringToCoTaskMemUni(value);
      return variant;
    }
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
    public void Dispose() { PropVariantClear(ref this); }
  }

  public static class ToastShortcut {
    public static void Create(string shortcutPath, string appId, string target, string arguments, string workingDirectory) {
      IShellLinkW link = (IShellLinkW)new ShellLink();
      link.SetPath(target);
      link.SetArguments(arguments);
      link.SetWorkingDirectory(workingDirectory);
      link.SetDescription("Open the LifeOS Pulse dashboard");
      link.SetIconLocation(Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\shell32.dll"), 15);

      IPropertyStore store = (IPropertyStore)link;
      PropertyKey appIdKey = new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 5);
      PropVariant value = PropVariant.FromString(appId);
      try { store.SetValue(ref appIdKey, ref value); store.Commit(); }
      finally { value.Dispose(); }

      ((IPersistFile)link).Save(shortcutPath, true);
      Marshal.FinalReleaseComObject(link);
    }
  }
}
'@

$directory = Split-Path -Parent $ShortcutPath
[IO.Directory]::CreateDirectory($directory) | Out-Null
$target = Join-Path $env:WINDIR "explorer.exe"
[LifeOS.Windows.ToastShortcut]::Create($ShortcutPath, $AppUserModelId, $target, "http://127.0.0.1:31337/", $env:USERPROFILE)
