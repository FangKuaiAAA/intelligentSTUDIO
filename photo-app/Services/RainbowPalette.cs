using System;
using Windows.UI;

namespace PhotoEditor.Services;

/// <summary>
/// 苹果智能五色取色器：笔迹、轮廓光环与进度光边共用同一套色板与换色节奏。
/// </summary>
public static class RainbowPalette
{
    /// <summary>每种颜色之间的过渡时长（秒）。</summary>
    public const double ColorStepSeconds = 5.0;

    /// <summary>整个色环走完一圈的时长。</summary>
    public const double ColorCycleSeconds = ColorStepSeconds * 4.0;

    public static readonly Color[] Colors =
    {
        Color.FromArgb(255, 255, 69, 58),   // 红
        Color.FromArgb(255, 191, 90, 242),  // 紫
        Color.FromArgb(255, 10, 132, 255),  // 蓝
        Color.FromArgb(255, 255, 214, 10),  // 黄
    };

    /// <summary>
    /// 多层同色叠加时累计浓度是 1 − ∏(1 − aᵢ)。直接给每层相同透明度会在内圈堆到接近实心，
    /// 这里按相邻两档差值反解，使叠加后浓度沿内→外线性衰减。
    /// </summary>
    public static float[] LayerAlphas(int layerCount, float maxAlpha)
    {
        var alphas = new float[layerCount];
        if (layerCount <= 0) return alphas;

        for (var i = 0; i < layerCount; i++)
        {
            var inner = maxAlpha * (1f - i / (float)(layerCount - 1));
            var outer = i + 1 < layerCount
                ? maxAlpha * (1f - (i + 1) / (float)(layerCount - 1))
                : 0f;

            alphas[i] = (inner - outer) / MathF.Max(1e-4f, 1f - outer);
        }
        return alphas;
    }

    /// <summary>绕色环取色（t 的整数部分被忽略），并写入指定浓度。</summary>
    public static Color At(float t, float alpha)
    {
        var x = t - MathF.Floor(t);
        var scaled = x * Colors.Length;
        var i0 = (int)scaled % Colors.Length;
        var i1 = (i0 + 1) % Colors.Length;
        var f = scaled - MathF.Floor(scaled);

        var a = (byte)Math.Clamp(Math.Round(alpha * 255), 0, 255);
        return Color.FromArgb(a,
            (byte)(Colors[i0].R + (Colors[i1].R - Colors[i0].R) * f),
            (byte)(Colors[i0].G + (Colors[i1].G - Colors[i0].G) * f),
            (byte)(Colors[i0].B + (Colors[i1].B - Colors[i0].B) * f));
    }
}
