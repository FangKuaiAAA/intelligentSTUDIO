using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// 提示词合成：元素名 + 文字元素 + 风格后缀，统一收口，便于后续接入 Office 插件时保持一致。
/// </summary>
public static class PromptComposer
{
    private const int MaxLength = 1200;

    public static string Compose(GenerationRequest request)
    {
        var style = StylePreset.FromKey(request.StyleKey);

        // 外部宿主直接给整段提示词：仅补充风格与画质要求
        if (!string.IsNullOrWhiteSpace(request.RawPrompt))
        {
            var sb = new StringBuilder(request.RawPrompt.Trim());
            if (style.PromptSuffix.Length > 0) sb.Append('，').Append(style.PromptSuffix);
            sb.Append("，构图完整，主体突出，高细节。");
            return Truncate(sb.ToString());
        }

        var subjects = new List<string>();
        foreach (var element in request.Elements)
        {
            var name = string.IsNullOrWhiteSpace(element.Prompt) ? element.Name : element.Prompt;
            if (name.Length > 0) subjects.Add(name);
        }
        foreach (var text in request.Texts)
        {
            var trimmed = text.Trim();
            if (trimmed.Length > 0) subjects.Add(trimmed);
        }

        if (subjects.Count == 0) return "";

        var unique = subjects.Distinct().ToList();
        var prompt = new StringBuilder();

        prompt.Append(style.Key == "any" ? "一幅画面" : $"一幅{style.Name}作品");
        prompt.Append("，画面包含：").Append(string.Join("、", unique));

        if (style.Key == "emoji")
            prompt.Append("；以上内容作为贴纸主体元素，统一置于圆形构图中");
        prompt.Append('。');

        if (style.PromptSuffix.Length > 0)
            prompt.Append(style.PromptSuffix).Append('。');

        prompt.Append("构图完整，主体突出，细节丰富，高清画质。");
        return Truncate(prompt.ToString());
    }

    private static string Truncate(string text) =>
        text.Length <= MaxLength ? text : text[..MaxLength];
}
