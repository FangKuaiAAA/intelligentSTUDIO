using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// 预设元素目录：读取随程序发布的 Assets/Elements/manifest.json（由 scripts/crop-playground-icons.ps1 生成）。
/// 图标本身以 ms-appx 绝对地址引用。
/// </summary>
public static class ElementCatalog
{
    private static readonly Lazy<IReadOnlyList<ElementPage>> LazyPages = new(Load);

    public static IReadOnlyList<ElementPage> Pages => LazyPages.Value;

    public static IReadOnlyList<PlaygroundElement> All =>
        Pages.SelectMany(p => p.Items).ToList();

    public static PlaygroundElement? FindByName(string name) =>
        All.FirstOrDefault(e => e.Name == name || e.Prompt == name);

    private static IReadOnlyList<ElementPage> Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "Elements", "manifest.json");
        try
        {
            var json = File.ReadAllText(path);
            var root = JsonSerializer.Deserialize<ManifestRoot>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });
            if (root?.Pages is null || root.Pages.Count == 0)
                throw new InvalidDataException("manifest 为空");

            var pages = new List<ElementPage>();
            foreach (var page in root.Pages)
            {
                var items = page.Items
                    .Select(i => new PlaygroundElement
                    {
                        Id = i.Id,
                        Name = i.Name,
                        Prompt = string.IsNullOrWhiteSpace(i.Prompt) ? i.Name : i.Prompt,
                        File = i.File,
                        Page = page.Page,
                    })
                    .ToList();
                pages.Add(new ElementPage { Page = page.Page, Title = page.Title, Items = items });
            }
            return pages;
        }
        catch (Exception ex)
        {
            AppLog.Write("ElementCatalog 读取失败", ex.GetType().Name);
            return Array.Empty<ElementPage>();
        }
    }

    private sealed class ManifestRoot
    {
        [JsonPropertyName("version")]
        public int Version { get; set; }

        [JsonPropertyName("pages")]
        public List<ManifestPage> Pages { get; set; } = new();
    }

    private sealed class ManifestPage
    {
        [JsonPropertyName("page")]
        public int Page { get; set; }

        [JsonPropertyName("title")]
        public string Title { get; set; } = "";

        [JsonPropertyName("items")]
        public List<ManifestItem> Items { get; set; } = new();
    }

    private sealed class ManifestItem
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("prompt")]
        public string Prompt { get; set; } = "";

        [JsonPropertyName("file")]
        public string File { get; set; } = "";
    }
}
