/// <reference types="vite/client" />

/** 把 CSS 作为字符串导入（内容脚本要把它注入 Shadow DOM，不能走全局样式表） */
declare module '*.css?inline' {
  const css: string
  export default css
}
