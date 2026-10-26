/**
 * 只声明用得到的那一小片 Office.js 与宿主全局对象。
 *
 * 不引 @types/office-js：那是一份几百 KB 的全量类型，本加载项只需要
 * onReady / context.host / requirements / actions.associate / addin / ribbon /
 * document.setSelectedDataAsync 这几处，其余一律走宿主适配层里的局部断言。
 */

declare namespace Office {
  interface AsyncResult<T = unknown> {
    status: 'succeeded' | 'failed'
    value?: T
    error?: { name?: string; message?: string; code?: string }
  }

  interface Options {
    coercionType?: string
    asyncContext?: unknown
  }

  interface Context {
    host: 'Word' | 'Excel' | 'PowerPoint' | 'Outlook' | string
    document: {
      setSelectedDataAsync(
        data: string,
        optionsOrCallback?: Options | ((r: AsyncResult) => void),
        callback?: (r: AsyncResult) => void
      ): void
      getSelectedDataAsync(
        coercionType: string,
        callback: (r: AsyncResult<string>) => void
      ): void
    }
    requirements: {
      isSetSupported(name: string, version?: string): boolean
    }
    ui?: { displayDialogAsync?: unknown }
  }

  const CoercionType: {
    Image: string
    Text: string
    Matrix: string
  }

  const AsyncResultStatus: { Succeeded: 'succeeded'; Failed: 'failed' }

  interface RibbonUpdaterData {
    tabs: Array<{
      id: string
      groups: Array<{
        id: string
        controls?: Array<{ id: string; enabled?: boolean; visible?: boolean }>
      }>
    }>
  }

  function onReady(callback?: (info: { host: string; platform: string }) => void): Promise<{ host: string; platform: string }>
  const actions: { associate(id: string, fn: (arg?: unknown) => void): void }
  const addin: {
    showAsTaskpane(): Promise<void>
    hide(): Promise<void>
  }
  const ribbon: { requestUpdate(data: RibbonUpdaterData): void }
  const context: Context
  const HostType: Record<string, string>
}

/** 宿主 API 命名空间：方法极多且各宿主不同，统一按需断言，不做全量类型 */
declare const Word: any
declare const Excel: any
declare const PowerPoint: any

interface Window {
  /** 桥在会话接口里下发的本地 token（同源取得，不出现在清单中） */
  __STUDIO_TOKEN__?: string
}
