#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$IconPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class AntiCodexExeIdentity {
    private delegate bool EnumName(IntPtr module, IntPtr type, IntPtr name, IntPtr data);
    private delegate bool EnumLanguage(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumName callback, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLanguage callback, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, int size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool EndUpdateResource(IntPtr update, bool discard);

    private sealed class Resource {
        public int Id;
        public string Name;
        public ushort Language;
        public byte[] Bytes;
        public IntPtr Identifier() { return Name == null ? new IntPtr(Id) : Marshal.StringToHGlobalUni(Name); }
        public void Release(IntPtr value) { if (Name != null) Marshal.FreeHGlobal(value); }
    }
    private sealed class Block {
        public string Key;
        public ushort Type;
        public ushort ValueLength;
        public byte[] Value;
        public List<Block> Children = new List<Block>();
    }
    private static int Align(int n) { return (n + 3) & ~3; }
    private static ushort U16(byte[] b, int p) { return BitConverter.ToUInt16(b, p); }
    private static uint U32(byte[] b, int p) { return BitConverter.ToUInt32(b, p); }
    private static void W16(Stream s, ushort n) { byte[] b = BitConverter.GetBytes(n); s.Write(b, 0, b.Length); }
    private static void W32(Stream s, uint n) { byte[] b = BitConverter.GetBytes(n); s.Write(b, 0, b.Length); }
    private static void Pad(Stream s) { while ((s.Position & 3) != 0) s.WriteByte(0); }
    private static Exception WinError() { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }

    private static List<Resource> Resources(IntPtr module, int type, bool includeBytes) {
        var result = new List<Resource>();
        EnumName names = delegate(IntPtr m, IntPtr t, IntPtr name, IntPtr ignored) {
            bool isId = ((ulong)name.ToInt64() >> 16) == 0;
            int id = isId ? name.ToInt32() : 0;
            string text = isId ? null : Marshal.PtrToStringUni(name);
            EnumLanguage languages = delegate(IntPtr lm, IntPtr lt, IntPtr ln, ushort language, IntPtr unused) {
                var entry = new Resource { Id = id, Name = text, Language = language };
                if (includeBytes) {
                    IntPtr found = FindResourceEx(lm, lt, ln, language);
                    if (found == IntPtr.Zero) throw WinError();
                    int length = checked((int)SizeofResource(lm, found));
                    IntPtr data = LockResource(LoadResource(lm, found));
                    if (data == IntPtr.Zero || length <= 0) throw new InvalidDataException("Resource data is missing.");
                    entry.Bytes = new byte[length];
                    Marshal.Copy(data, entry.Bytes, 0, length);
                }
                result.Add(entry);
                return true;
            };
            if (!EnumResourceLanguages(m, t, name, languages, IntPtr.Zero)) throw WinError();
            return true;
        };
        EnumResourceNames(module, new IntPtr(type), names, IntPtr.Zero);
        return result;
    }

    private static Block ReadBlock(byte[] data, int start, int limit) {
        if (start + 6 > limit) throw new InvalidDataException("Version resource is truncated.");
        int end = start + U16(data, start);
        if (end > limit || end <= start + 6) throw new InvalidDataException("Version block length is invalid.");
        ushort valueLength = U16(data, start + 2), type = U16(data, start + 4);
        int p = start + 6, keyStart = p;
        while (p + 1 < end && U16(data, p) != 0) p += 2;
        if (p + 1 >= end) throw new InvalidDataException("Version key is truncated.");
        string key = Encoding.Unicode.GetString(data, keyStart, p - keyStart);
        p = Align(p + 2);
        int valueBytes = type == 1 ? valueLength * 2 : valueLength;
        if (p + valueBytes > end) throw new InvalidDataException("Version value is truncated.");
        var block = new Block { Key = key, Type = type, ValueLength = valueLength, Value = new byte[valueBytes] };
        Buffer.BlockCopy(data, p, block.Value, 0, valueBytes);
        p = Align(p + valueBytes);
        while (p + 6 <= end && U16(data, p) != 0) {
            block.Children.Add(ReadBlock(data, p, end));
            p = Align(p + U16(data, p));
        }
        return block;
    }
    private static void Brand(Block block, ref int description, ref int product) {
        if (block.Key == "FileDescription" || block.Key == "ProductName") {
            if (block.Type != 1) throw new InvalidDataException("Version name is not text.");
            block.Value = Encoding.Unicode.GetBytes("Anti-Codex\0");
            block.ValueLength = (ushort)(block.Value.Length / 2);
            if (block.Key == "FileDescription") description++; else product++;
        }
        foreach (Block child in block.Children) Brand(child, ref description, ref product);
    }
    private static void WriteBlock(MemoryStream stream, Block block) {
        long start = stream.Position;
        W16(stream, 0); W16(stream, block.ValueLength); W16(stream, block.Type);
        byte[] key = Encoding.Unicode.GetBytes(block.Key + "\0");
        stream.Write(key, 0, key.Length); Pad(stream);
        stream.Write(block.Value, 0, block.Value.Length); Pad(stream);
        foreach (Block child in block.Children) { WriteBlock(stream, child); Pad(stream); }
        long end = stream.Position;
        if (end - start > UInt16.MaxValue) throw new InvalidDataException("Version resource is too large.");
        stream.Position = start; W16(stream, (ushort)(end - start)); stream.Position = end;
    }
    private static byte[] BrandVersion(byte[] data) {
        Block root = ReadBlock(data, 0, data.Length);
        if (root.Key != "VS_VERSION_INFO") throw new InvalidDataException("Version resource root is invalid.");
        int descriptions = 0, products = 0;
        Brand(root, ref descriptions, ref products);
        if (descriptions == 0 || products == 0) throw new InvalidDataException("Version names are missing.");
        using (var stream = new MemoryStream()) { WriteBlock(stream, root); return stream.ToArray(); }
    }
    private static void Set(IntPtr update, int type, Resource resource, byte[] bytes) {
        IntPtr name = resource.Identifier();
        try { if (!UpdateResource(update, new IntPtr(type), name, resource.Language, bytes, bytes.Length)) throw WinError(); }
        finally { resource.Release(name); }
    }

    public static void Patch(string exe, string icoPath) {
        byte[] ico = File.ReadAllBytes(icoPath);
        if (ico.Length < 6 || U16(ico, 0) != 0 || U16(ico, 2) != 1) throw new InvalidDataException("Invalid icon.");
        int count = U16(ico, 4);
        if (count < 1 || count > 255 || 6 + count * 16 > ico.Length) throw new InvalidDataException("Invalid icon entries.");
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, 0x00000002);
        if (module == IntPtr.Zero) throw WinError();
        List<Resource> versions, groups, icons;
        try { versions = Resources(module, 16, true); groups = Resources(module, 14, false); icons = Resources(module, 3, false); }
        finally { FreeLibrary(module); }
        if (versions.Count == 0) throw new InvalidDataException("Executable version resource is missing.");
        Resource first = groups.Find(x => x.Name == "IDR_MAINFRAME");
        if (first == null) first = groups.Count > 0 ? groups[0] : new Resource { Id = 1, Language = 1033 };
        var selected = groups.FindAll(x => x.Name == first.Name && x.Id == first.Id);
        if (selected.Count == 0) selected.Add(first);
        var used = new HashSet<int>();
        foreach (Resource icon in icons) if (icon.Name == null) used.Add(icon.Id);
        ushort[] ids = new ushort[count];
        int nextId = 60000;
        for (int i = 0; i < count; i++) {
            while (nextId <= UInt16.MaxValue && used.Contains(nextId)) nextId++;
            if (nextId > UInt16.MaxValue) throw new InvalidDataException("No available icon resource IDs.");
            ids[i] = (ushort)nextId++;
        }
        using (var group = new MemoryStream()) {
            W16(group, 0); W16(group, 1); W16(group, (ushort)count);
            for (int i = 0; i < count; i++) {
                int p = 6 + i * 16;
                uint size = U32(ico, p + 8), offset = U32(ico, p + 12);
                if (size == 0 || offset > ico.Length || size > ico.Length - offset) throw new InvalidDataException("Icon image is truncated.");
                group.Write(ico, p, 8); W32(group, size); W16(group, ids[i]);
            }
            IntPtr update = BeginUpdateResource(exe, false);
            if (update == IntPtr.Zero) throw WinError();
            bool committed = false;
            try {
                foreach (Resource version in versions) Set(update, 16, version, BrandVersion(version.Bytes));
                foreach (Resource target in selected) {
                    for (int i = 0; i < count; i++) {
                        int p = 6 + i * 16, size = checked((int)U32(ico, p + 8)), offset = checked((int)U32(ico, p + 12));
                        byte[] bytes = new byte[size]; Buffer.BlockCopy(ico, offset, bytes, 0, size);
                        Set(update, 3, new Resource { Id = ids[i], Language = target.Language }, bytes);
                    }
                    Set(update, 14, target, group.ToArray());
                }
                if (!EndUpdateResource(update, false)) throw WinError();
                committed = true;
            } finally { if (!committed) EndUpdateResource(update, true); }
        }
    }
}
'@

if (-not ("AntiCodexExeIdentity" -as [type])) { Add-Type -TypeDefinition $source -Language CSharp }
[AntiCodexExeIdentity]::Patch((Resolve-Path -LiteralPath $ExePath).Path, (Resolve-Path -LiteralPath $IconPath).Path)
