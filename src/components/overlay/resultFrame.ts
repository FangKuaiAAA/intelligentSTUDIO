import { createContext } from 'react'
import type { RefObject } from 'react'

/**
 * 结果框的「目标尺寸」与卡片节点，供框内的文字飞入使用。
 *
 * 飞入的起点是**框的最终底部**（所有行统一位置），所以必须提前知道算好的目标高度 ——
 * 即便此刻框还在扩大、还没到那个位置。这两个值由 DonyMorph 量好后往下发。
 */
export interface ResultFrameInfo {
  /** 结果框的目标高度（px）；还没量出来时为 null */
  height: number | null
  /** 结果框（卡片）本体，用来把"框底"换算成视口坐标 */
  cardRef: RefObject<HTMLDivElement> | null
}

export const ResultFrameContext = createContext<ResultFrameInfo>({ height: null, cardRef: null })

/**
 * 结果区的「飞入序列」：正文每一行 + 每张结果卡片，都算这条序列上的一个条目。
 *
 * 正文与卡片共用同一个总条目数来算节奏，于是卡片是**接在文字后面**飞的，
 * 而不是各飞各的 —— 最后一张卡片飞完 = 最后一行飞完 = 框扩到位。
 * 条目数只有 App 知道（正文与卡片都在那里），所以由 App 提供。
 */
export interface ResultSequenceInfo {
  /** 正文行数 */
  lineCount: number
  /** 结果卡片数 */
  cardCount: number
}

export const ResultSequenceContext = createContext<ResultSequenceInfo>({
  lineCount: 0,
  cardCount: 0,
})
