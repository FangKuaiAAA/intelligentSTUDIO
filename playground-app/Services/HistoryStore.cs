using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// 历史作品库：用户图片库下的 Pictures\图乐园\，图片与 index.json 同目录。
/// 写入用「临时文件 + 原子替换」，并用信号量串行化，避免多窗口/多线程互相覆盖索引。
/// </summary>
public sealed class HistoryStore
{
    public static HistoryStore Instance { get; } = new();

    private readonly SemaphoreSlim _gate = new(1, 1);

    // 保留中文原文（默认编码器会把中文转成 \uXXXX，索引文件不便阅读）
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private HistoryStore()
    {
        Root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "图乐园");
    }

    public string Root { get; }

    private string IndexPath => Path.Combine(Root, "index.json");

    public async Task<List<HistoryEntry>> LoadAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            return ReadIndex()
                .OrderByDescending(e => e.CreatedAt)
                .Where(e =>
                {
                    e.ImagePath = Path.Combine(Root, e.File);
                    return File.Exists(e.ImagePath);
                })
                .ToList();
        }
        finally { _gate.Release(); }
    }

    /// <summary>把缓存目录中的结果图收进历史库，并写索引。</summary>
    public async Task<HistoryEntry> AddAsync(
        string cachedImagePath, string prompt, string styleKey,
        IEnumerable<string> elementNames, int size)
    {
        if (!File.Exists(cachedImagePath))
            throw new ImageGenerationException("结果图片已不存在，请重新生成。");

        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(Root);
            var now = DateTimeOffset.Now;
            var fileName = $"yg_{now:yyyyMMdd_HHmmss_fff}.png";
            var dest = Path.Combine(Root, fileName);
            File.Copy(cachedImagePath, dest, overwrite: true);

            var entry = new HistoryEntry
            {
                Id = Guid.NewGuid().ToString("n"),
                File = fileName,
                Prompt = prompt,
                Style = styleKey,
                CreatedAt = now,
                Size = size,
                Elements = elementNames.Where(n => !string.IsNullOrWhiteSpace(n)).ToList(),
                ImagePath = dest,
            };

            var list = ReadIndex();
            list.Insert(0, entry);
            WriteIndex(list);

            AppLog.Info("已保存到历史", fileName);
            return entry;
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// 从历史库移除一条记录：先更新索引（界面立即不再显示），再尽力删除图片文件。
    /// 文件可能正被缩略图解码占用，删除失败时保留为孤儿文件，不影响索引一致性。
    /// </summary>
    public async Task DeleteAsync(HistoryEntry entry)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var list = ReadIndex();
            list.RemoveAll(e => string.Equals(e.Id, entry.Id, StringComparison.Ordinal));
            WriteIndex(list);

            var path = Path.Combine(Root, entry.File);
            for (var attempt = 0; attempt < 3 && File.Exists(path); attempt++)
            {
                try
                {
                    File.Delete(path);
                    break;
                }
                catch (IOException)
                {
                    await Task.Delay(150).ConfigureAwait(false);
                }
                catch (UnauthorizedAccessException)
                {
                    break;
                }
            }

            AppLog.Info("已从历史删除", entry.File);
        }
        finally { _gate.Release(); }
    }

    private List<HistoryEntry> ReadIndex()
    {
        if (!File.Exists(IndexPath)) return new List<HistoryEntry>();
        try
        {
            var json = File.ReadAllText(IndexPath);
            return JsonSerializer.Deserialize<List<HistoryEntry>>(json, JsonOpts) ?? new List<HistoryEntry>();
        }
        catch (Exception ex)
        {
            AppLog.Write("历史索引损坏", ex.GetType().Name);
            try { File.Copy(IndexPath, IndexPath + ".broken", overwrite: true); } catch { }
            return new List<HistoryEntry>();
        }
    }

    private void WriteIndex(List<HistoryEntry> entries)
    {
        Directory.CreateDirectory(Root);
        var json = JsonSerializer.Serialize(entries, JsonOpts);
        var temp = IndexPath + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, IndexPath, overwrite: true);
    }
}
